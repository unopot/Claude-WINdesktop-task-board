// 标题栏计数：贴在 Claude 桌面应用窗口标题栏右侧的一个小胶囊（黄 = needs input，蓝 = running / waiting，绿 = done），
// 点开是各会话，点一行切过去。不长在会话里：停在新建会话页、开着 Remote Control 会话时也看得到。
// counter.ps1 用 Windows 自带的 PowerShell（Add-Type）当场编译它，不用另装任何东西。
//
// 它是一个很小的独立窗口，“属于” Claude 窗口（owner）：总在 Claude 窗口上面，跟着它移动，Claude 最小化 / 被挡住 / 关掉时一起不见。
// 数据和任务板同源：自己跑一份 scan.ps1，读它每 3 秒一行的输出；筛选、排序照 register.tsx 的 isActive / isHidden、plan.ts 的 mergeRemote。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TaskBoardCounter {

public class Row {
  public string Id = "", Title = "", Link = "", Bridge = "", Project = "", Status = "idle", Current = "", Device = null;
  public double AgeSec, CacheAgeSec = -1, TurnSec = -1;
  public int Done, Total;
  public bool IsLive { get { return Status == "input" || Status == "running" || Status == "waiting"; } }
}

/** 扫描结果 → 要列出的会话；和任务板一样的规则。 */
public static class Plan {
  public const int ACTIVE_SEC = 60 * 60;        // 多久没动静就不再列出（在跑 / 在等的始终列出）
  public const int REMOTE_MAX_SEC = 10 * 60;    // 别的电脑的快照超过这么久没更新 = 离线
  public static readonly Dictionary<string, int> ORDER = new Dictionary<string, int> { { "input", 0 }, { "running", 1 }, { "waiting", 2 }, { "done", 3 }, { "idle", 4 } };
  static readonly System.Text.RegularExpressions.Regex BRIDGE_ID = new System.Text.RegularExpressions.Regex("^(cse|session)_[A-Za-z0-9_-]+$");
  static readonly System.Text.RegularExpressions.Regex LOCAL_LINK = new System.Text.RegularExpressions.Regex("^claude://claude\\.ai/epitaxy/local_[0-9a-f-]+$");

  static double Num(Dictionary<string, object> d, string k, double dflt) {
    object v; if (!d.TryGetValue(k, out v) || v == null) return dflt;
    try { return Convert.ToDouble(v); } catch { return dflt; }
  }
  static string Str(Dictionary<string, object> d, string k) {
    object v; return d.TryGetValue(k, out v) && v is string ? (string)v : "";
  }

  static Row RowOf(Dictionary<string, object> d, double shift, string device) {
    Func<double, double> later = x => x >= 0 ? x + shift : x;
    return new Row {
      Id = Str(d, "id"), Title = Str(d, "title"), Link = Str(d, "link"), Bridge = Str(d, "bridge"), Project = Str(d, "project"),
      Status = Str(d, "status") == "" ? "idle" : Str(d, "status"), Current = Str(d, "current"), Device = device,
      AgeSec = Num(d, "ageSec", 0) + shift, CacheAgeSec = later(Num(d, "cacheAgeSec", -1)), TurnSec = later(Num(d, "turnSec", -1)),
      Done = (int)Num(d, "done", 0), Total = (int)Num(d, "total", 0),
    };
  }

  /** 本机的会话 + 别的电脑的快照（秒数按快照时间往后推，离线的跳过，同一会话取最新的一份），同 plan.ts 的 mergeRemote。 */
  public static List<Row> Merge(Dictionary<string, object> got, double at) {
    var own = new List<Row>();
    foreach (var o in (got.ContainsKey("sessions") ? got["sessions"] as IList : null) ?? new ArrayList()) {
      var d = o as Dictionary<string, object>; if (d != null) own.Add(RowOf(d, 0, null));
    }
    var ids = new HashSet<string>(own.Select(r => r.Id));
    var picked = new Dictionary<string, KeyValuePair<double, Row>>();
    foreach (var o in (got.ContainsKey("remote") ? got["remote"] as IList : null) ?? new ArrayList()) {
      var r = o as Dictionary<string, object>;
      if (r == null) continue;
      var device = Str(r, "device"); var rat = Num(r, "at", 0);
      var list = r.ContainsKey("sessions") ? r["sessions"] as IList : null;
      if (device == "" || rat <= 0 || list == null) continue;
      var shift = Math.Max(0, Math.Round((at - rat) / 1000));
      if (shift > REMOTE_MAX_SEC) continue;
      foreach (var so in list) {
        var s = so as Dictionary<string, object>; if (s == null) continue;
        var id = Str(s, "id"); if (id == "" || ids.Contains(id)) continue;
        KeyValuePair<double, Row> prev;
        if (picked.TryGetValue(id, out prev) && prev.Key >= rat) continue;
        picked[id] = new KeyValuePair<double, Row>(rat, RowOf(s, shift, device));
      }
    }
    own.AddRange(picked.Values.Select(x => x.Value));
    return own;
  }

  /** 在跑 / 在等的都列；其余 1 小时内有请求且缓存没过期的才列；任务板上隐藏的不列；按状态、再按最近排。 */
  public static List<Row> Visible(Dictionary<string, object> got, int ttlSec) {
    var at = Num(got, "at", 0);
    var hidden = new Dictionary<string, double>();
    object po; var prefs = got.TryGetValue("prefs", out po) ? po as Dictionary<string, object> : null;
    object ho; var h = prefs != null && prefs.TryGetValue("hidden", out ho) ? ho as Dictionary<string, object> : null;
    if (h != null) foreach (var kv in h) { try { hidden[kv.Key] = Convert.ToDouble(kv.Value); } catch { } }
    return Merge(got, at).Where(s => {
      if (s.IsLive) return true;
      var quiet = s.CacheAgeSec >= 0 ? s.CacheAgeSec : s.AgeSec;
      var hasLeft = s.CacheAgeSec >= 0;
      if (!(quiet < ACTIVE_SEC && (!hasLeft || ttlSec - s.CacheAgeSec > 0))) return false;
      double hv;
      return !hidden.TryGetValue(s.Id, out hv) || at - quiet * 1000 > hv + 15000;
    }).OrderBy(s => ORDER.ContainsKey(s.Status) ? ORDER[s.Status] : 9).ThenBy(s => s.AgeSec).ToList();
  }

  /** 点一行要打开的链接：本机的切到桌面应用里那个会话；别的电脑的走 Remote Control。 */
  public static string LinkOf(Row s) {
    if (s.Device != null) return BRIDGE_ID.IsMatch(s.Bridge) ? "claude://claude.ai/code/" + s.Bridge : "";
    return LOCAL_LINK.IsMatch(s.Link) ? s.Link : "";
  }

  public static string When(Row s) {
    if (s.IsLive) {
      var t = s.TurnSec >= 0 ? s.TurnSec : s.AgeSec;
      return t < 60 ? Math.Floor(t) + " s" : Math.Floor(t / 60) + " min";
    }
    var a = s.AgeSec;
    return a < 60 ? "just now" : a < 3600 ? Math.Floor(a / 60) + " min ago" : Math.Floor(a / 3600) + " h ago";
  }
}

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc f, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
}

/** 胶囊和下拉里共用的画法。 */
static class Draw {
  public static Color Hex(string hex) { return ColorTranslator.FromHtml(hex); }
  public static readonly Dictionary<string, string> HEX = new Dictionary<string, string> {
    { "input", "#f5b324" }, { "running", "#3b82f6" }, { "waiting", "#7cc4f5" }, { "done", "#34a853" }, { "idle", "#8b8f98" } };
  public static readonly Dictionary<string, string> LABEL = new Dictionary<string, string> {
    { "input", "needs input" }, { "running", "running" }, { "waiting", "waiting" }, { "done", "done" }, { "idle", "idle" } };
  public static GraphicsPath Round(RectangleF r, float rad) {
    var p = new GraphicsPath(); var d = rad * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure();
    return p;
  }
  public static Font UI(float px, FontStyle st = FontStyle.Regular) { return new Font("Segoe UI", px, st, GraphicsUnit.Pixel); }
}

/** 主题：从标题栏取一个像素的亮度判断深 / 浅色。 */
class Theme {
  public bool Dark = true;
  public Color PillBg { get { return Dark ? Color.FromArgb(0x2b, 0x2b, 0x2b) : Color.FromArgb(0xec, 0xec, 0xec); } }
  public Color PillLine { get { return Dark ? Color.FromArgb(0x45, 0x45, 0x45) : Color.FromArgb(0xd0, 0xd0, 0xd0); } }
  public Color MenuBg { get { return Dark ? Color.FromArgb(0x26, 0x26, 0x26) : Color.White; } }
  public Color MenuLine { get { return Dark ? Color.FromArgb(0x45, 0x45, 0x45) : Color.FromArgb(0xd0, 0xd4, 0xda); } }
  public Color Text { get { return Dark ? Color.FromArgb(0xec, 0xec, 0xec) : Color.FromArgb(0x1f, 0x23, 0x28); } }
  public Color Muted { get { return Color.FromArgb(0x8b, 0x8f, 0x98); } }
  public Color Hover { get { return Dark ? Color.FromArgb(0x33, 0x41, 0x5c) : Color.FromArgb(0xe8, 0xf0, 0xfe); } }
  public Color TagBg { get { return Dark ? Color.FromArgb(0x3a, 0x3a, 0x3a) : Color.FromArgb(0xea, 0xec, 0xef); } }
}

/** 不抢焦点、不进任务栏的无边框小窗口。 */
class Floating : Form {
  public Floating() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
  }
  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= 0x80; /* WS_EX_TOOLWINDOW */ return cp; }
  }
  public void Own(IntPtr owner) { Native.SetWindowLongPtr(Handle, -8 /* GWLP_HWNDPARENT */, owner); }
}

class Pill : Floating {
  public Func<List<Row>> Rows; public Theme Theme; public float Zoom = 1; public Action Clicked;
  bool hover;
  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000; /* WS_EX_NOACTIVATE */ return cp; }
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  public Pill() { Cursor = Cursors.Hand; }
  protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); }
  protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); }
  protected override void OnMouseUp(MouseEventArgs e) { if (e.Button == MouseButtons.Left && Clicked != null) Clicked(); }

  /** 各部分：(数量, 颜色)；都为 0 = 只画一个灰点。 */
  public List<KeyValuePair<int, string>> Parts() {
    var rows = Rows();
    var parts = new List<KeyValuePair<int, string>> {
      new KeyValuePair<int, string>(rows.Count(s => s.Status == "input"), Draw.HEX["input"]),
      new KeyValuePair<int, string>(rows.Count(s => s.Status == "running" || s.Status == "waiting"), Draw.HEX["running"]),
      new KeyValuePair<int, string>(rows.Count(s => s.Status == "done" || s.Status == "idle"), Draw.HEX["done"]),
    };
    return parts.Where(p => p.Key > 0).ToList();
  }

  /** 按内容算宽度（像素）。 */
  public int Measure() {
    using (var g = CreateGraphics()) using (var f = Draw.UI(12 * Zoom, FontStyle.Bold)) {
      var parts = Parts();
      if (parts.Count == 0) return (int)Math.Ceiling(26 * Zoom);
      float w = 8 * Zoom;
      foreach (var p in parts) w += 8 * Zoom + 4 * Zoom + TextRenderer.MeasureText(g, p.Key.ToString(), f, Size.Empty, TextFormatFlags.NoPadding).Width + 7 * Zoom;
      return (int)Math.Ceiling(w + 1 * Zoom);
    }
  }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
    g.Clear(Theme.Dark ? Color.FromArgb(0x1f, 0x1f, 0x1f) : Color.FromArgb(0xf8, 0xf8, 0xf8));
    var r = new RectangleF(0.5f, 0.5f, Width - 1, Height - 1);
    using (var path = Draw.Round(r, 6 * Zoom)) {
      using (var b = new SolidBrush(hover ? Theme.Hover : Theme.PillBg)) g.FillPath(b, path);
      using (var pen = new Pen(Theme.PillLine)) g.DrawPath(pen, path);
    }
    var parts = Parts(); var d = 7 * Zoom; var cy = Height / 2f;
    if (parts.Count == 0) {
      using (var b = new SolidBrush(Draw.Hex(Draw.HEX["idle"]))) g.FillEllipse(b, (Width - d) / 2f, cy - d / 2, d, d);
      return;
    }
    using (var f = Draw.UI(12 * Zoom, FontStyle.Bold)) {
      float x = 8 * Zoom;
      foreach (var p in parts) {
        var c = Draw.Hex(p.Value);
        using (var b = new SolidBrush(c)) g.FillEllipse(b, x, cy - d / 2, d, d);
        x += d + 4 * Zoom;
        var t = p.Key.ToString();
        var sz = TextRenderer.MeasureText(g, t, f, Size.Empty, TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, t, f, new Point((int)x, (int)(cy - sz.Height / 2f)), c, TextFormatFlags.NoPadding);
        x += sz.Width + 7 * Zoom;
      }
    }
  }
}

class Menu : Floating {
  public Theme Theme; public float Zoom = 1;
  List<object> items = new List<object>();   // string = 小标题；Row = 一行；null = 分隔线
  string footer = "";
  int hoverIdx = -1;
  public DateTime ClosedAt = DateTime.MinValue;
  const int ROWS_MAX = 20;

  int RowH { get { return (int)(30 * Zoom); } }
  int HeadH { get { return (int)(26 * Zoom); } }
  int Pad { get { return (int)(6 * Zoom); } }

  public void Fill(List<Row> rows, string foot) {
    items.Clear(); footer = foot; hoverIdx = -1;
    var live = rows.Where(s => s.IsLive).ToList(); var finished = rows.Where(s => !s.IsLive).ToList();
    if (live.Count > 0) { items.Add("Running · " + live.Count); items.AddRange(live.Take(ROWS_MAX)); }
    if (finished.Count > 0) { items.Add("Done · " + finished.Count); items.AddRange(finished.Take(ROWS_MAX)); }
    if (rows.Count == 0) items.Add("No sessions in the last hour");
    items.Add(null);
    int h = Pad * 2 + items.Sum(i => i is Row ? RowH : i == null ? (int)(9 * Zoom) : HeadH) + HeadH;
    Size = new Size((int)(560 * Zoom), h);
    using (var path = Draw.Round(new RectangleF(0, 0, Width, Height), 8 * Zoom)) Region = new Region(path);
    Invalidate();
  }

  Rectangle RowRect(int idx) {
    int y = Pad;
    for (int i = 0; i < items.Count; i++) {
      int h = items[i] is Row ? RowH : items[i] == null ? (int)(9 * Zoom) : HeadH;
      if (i == idx) return new Rectangle(Pad, y, Width - Pad * 2, h);
      y += h;
    }
    return new Rectangle(Pad, y, Width - Pad * 2, HeadH);
  }

  int HitTest(Point p) {
    for (int i = 0; i < items.Count; i++) if (items[i] is Row && RowRect(i).Contains(p)) return i;
    return -1;
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    var i = HitTest(e.Location);
    if (i >= 0 && Plan.LinkOf((Row)items[i]) == "") i = -1;
    if (i != hoverIdx) { hoverIdx = i; Cursor = i >= 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
  }
  protected override void OnMouseLeave(EventArgs e) { hoverIdx = -1; Invalidate(); }
  protected override void OnMouseUp(MouseEventArgs e) {
    var i = HitTest(e.Location); if (i < 0) return;
    var link = Plan.LinkOf((Row)items[i]); if (link == "") return;
    Hide();
    try { Process.Start(new ProcessStartInfo(link) { UseShellExecute = true }); } catch { }
  }
  protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); if (Visible) { Hide(); ClosedAt = DateTime.UtcNow; } }
  protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Escape) Hide(); }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    g.Clear(Theme.MenuBg);
    using (var pen = new Pen(Theme.MenuLine)) using (var path = Draw.Round(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 8 * Zoom)) g.DrawPath(pen, path);
    using (var head = Draw.UI(12 * Zoom, FontStyle.Bold)) using (var main = Draw.UI(14 * Zoom)) using (var small = Draw.UI(12 * Zoom)) {
      var flags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix;
      for (int i = 0; i < items.Count; i++) {
        var b = RowRect(i); var it = items[i];
        if (it == null) { using (var pen = new Pen(Theme.MenuLine)) g.DrawLine(pen, b.Left + 4 * Zoom, b.Top + b.Height / 2, b.Right - 4 * Zoom, b.Top + b.Height / 2); continue; }
        var str = it as string;
        if (str != null) { TextRenderer.DrawText(g, str, head, new Rectangle(b.Left + (int)(10 * Zoom), b.Top, b.Width, b.Height), Theme.Muted, flags); continue; }
        var s = (Row)it; var c = Draw.Hex(Draw.HEX.ContainsKey(s.Status) ? Draw.HEX[s.Status] : Draw.HEX["idle"]);
        if (i == hoverIdx) using (var hb = new SolidBrush(Theme.Hover)) using (var hp = Draw.Round(b, 5 * Zoom)) g.FillPath(hb, hp);
        float d = 9 * Zoom; int x = b.Left + (int)(12 * Zoom); int cy = b.Top + b.Height / 2;
        using (var db = new SolidBrush(c)) g.FillEllipse(db, x, cy - d / 2, d, d);
        x += (int)(d + 9 * Zoom);
        if (s.Device != null) {
          var tsz = TextRenderer.MeasureText(g, s.Device, small, Size.Empty, TextFormatFlags.NoPadding);
          var tr = new RectangleF(x, cy - 9 * Zoom, tsz.Width + 10 * Zoom, 18 * Zoom);
          using (var tb = new SolidBrush(Theme.TagBg)) using (var tp = Draw.Round(tr, 4 * Zoom)) g.FillPath(tb, tp);
          TextRenderer.DrawText(g, s.Device, small, new Point((int)(x + 5 * Zoom), (int)(cy - tsz.Height / 2f)), Theme.Muted, TextFormatFlags.NoPadding);
          x += (int)tr.Width + (int)(6 * Zoom);
        }
        // 右半边：状态 · 项目 · 时间 · 进度；左半边标题，放不下就截断
        var progress = s.Total > 0 ? " · " + s.Done + "/" + s.Total : "";
        var meta = " · " + s.Project + " · " + Plan.When(s) + progress;
        var label = Draw.LABEL.ContainsKey(s.Status) ? Draw.LABEL[s.Status] : s.Status;
        var lw = TextRenderer.MeasureText(g, label, small, Size.Empty, TextFormatFlags.NoPadding).Width;
        var mw = Math.Min(TextRenderer.MeasureText(g, meta, small, Size.Empty, TextFormatFlags.NoPadding).Width, (int)(200 * Zoom));
        var right = b.Right - (int)(10 * Zoom);
        var titleMax = right - x - lw - mw - (int)(10 * Zoom);
        var title = s.Title == "" ? "(untitled)" : s.Title;
        var tw = Math.Min(TextRenderer.MeasureText(g, title, main, Size.Empty, TextFormatFlags.NoPadding).Width, titleMax);
        TextRenderer.DrawText(g, title, main, new Rectangle(x, b.Top, tw, b.Height), Theme.Text, flags);
        x += tw + (int)(8 * Zoom);
        TextRenderer.DrawText(g, label, small, new Rectangle(x, b.Top, lw, b.Height), c, flags);
        x += lw;
        TextRenderer.DrawText(g, meta, small, new Rectangle(x, b.Top, Math.Max(0, right - x), b.Height), Theme.Muted, flags);
      }
      var fb = RowRect(items.Count);
      TextRenderer.DrawText(g, footer, small, new Rectangle(fb.Left + (int)(10 * Zoom), fb.Top, fb.Width, fb.Height), Theme.Muted, flags);
    }
    // 没有 Exit：关掉要去设置项（点了退出要等下一个会话才回来，用户不要）
  }
}

public class App {
  // 胶囊在标题栏里的位置（按 96 dpi 的像素；实际乘以 Claude 窗口的缩放）：右边离窗口右边缘 RIGHT_GAP，上边离顶 TOP，高 HEIGHT
  const int RIGHT_GAP = 318, TOP = 9, HEIGHT = 18, MIN_WIDTH = 760;

  readonly string scanPath, latestShared, device, pidPath;
  readonly int ttlSec;
  readonly int myPid = Process.GetCurrentProcess().Id;
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  readonly Theme theme = new Theme();
  Pill pill; Menu menu; Timer timer;
  IntPtr owner = IntPtr.Zero;
  Process scanner; IntPtr job = IntPtr.Zero; DateTime scanStartedAt = DateTime.MinValue;
  volatile string lastLine;
  Dictionary<string, object> got; List<Row> rows = new List<Row>();
  DateTime themeAt = DateTime.MinValue;
  // 跟着 Claude 窗口走：订阅它所在进程的“位置变了 / 最小化”事件，一动就当场重新摆（只靠定时器查会落后半秒）
  Native.WinEventProc hookProc; readonly List<IntPtr> hooks = new List<IntPtr>(); uint hookedPid;
  int pillW = -1;

  public App(string scan, int ttlMin, string shared, string dev) {
    scanPath = scan; ttlSec = Math.Max(1, ttlMin) * 60; latestShared = shared; device = dev == "" ? "Win" : dev;
    pidPath = Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE"), ".claude", "task-board-counter.pid");
  }

  public static void Run(string scan, int ttlMin, string shared, string dev) {
    try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }   // 每个显示器各自的缩放（PER_MONITOR_AWARE_V2）
    Application.EnableVisualStyles();
    new App(scan, ttlMin, shared, dev).Start();
  }

  void Start() {
    pill = new Pill { Rows = () => rows, Theme = theme, Clicked = Toggle };
    menu = new Menu { Theme = theme };
    job = Native.CreateJobObject(IntPtr.Zero, null);
    var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：本进程没了（含被强杀），扫描进程跟着退
    Native.SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(info));
    timer = new Timer { Interval = 500 };
    int n = 0;
    timer.Tick += (s, e) => { Follow(); if (n++ % 4 == 0) Tick(); };
    hookProc = (hook, ev, h, idObject, idChild, thread, time) => { if (h == owner && idObject == 0) Place(); };
    Tick(); Follow();
    timer.Start();
    Application.Run();
  }

  void Quit() {
    timer.Stop();
    try { if (scanner != null && !scanner.HasExited) scanner.Kill(); } catch { }
    try { if (File.Exists(pidPath) && File.ReadAllText(pidPath).Trim() == myPid.ToString()) File.Delete(pidPath); } catch { }
    Application.ExitThread();
  }

  /** 每 2 秒：插件升级（旧版本目录没了）或者被新实例顶掉就退出；守住扫描进程；读新数据。 */
  void Tick() {
    if (scanPath == "" || !File.Exists(scanPath)) { Quit(); return; }
    try { var owner = File.ReadAllText(pidPath).Trim(); if (owner != myPid.ToString()) { Quit(); return; } } catch (FileNotFoundException) { Quit(); return; } catch { }
    EnsureScanner();
    var line = lastLine;
    if (line != null) {
      try {
        var g = json.Deserialize<Dictionary<string, object>>(line);
        if (g != null && g.ContainsKey("at")) { got = g; rows = Plan.Visible(g, ttlSec); }
      } catch { }
    }
    var w = pill.Measure();
    if (w != pillW) { pillW = w; Place(); }
    pill.Invalidate();
    if (menu.Visible) menu.Fill(rows, Footer());
  }

  void EnsureScanner() {
    if (scanner != null && !scanner.HasExited) return;
    if ((DateTime.UtcNow - scanStartedAt).TotalSeconds < 10) return;   // 刚起过又退了：隔 10 秒再试
    scanStartedAt = DateTime.UtcNow;
    var args = "-NoProfile -ExecutionPolicy Bypass -File \"" + scanPath + "\" -Hours 24 -Max 12";
    if (latestShared != "") args += " -Shared \"" + latestShared + "\" -Device \"" + device + "\"";
    var psi = new ProcessStartInfo("powershell.exe", args) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
    };
    try {
      var p = new Process { StartInfo = psi };
      p.OutputDataReceived += (s, e) => { if (e.Data != null && e.Data.StartsWith("{")) lastLine = e.Data; };
      p.ErrorDataReceived += (s, e) => { };
      p.Start();
      if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, p.Handle);
      p.BeginOutputReadLine(); p.BeginErrorReadLine();
      scanner = p;
    } catch { scanner = null; }
  }

  string Footer() {
    if (got == null) return "Waiting for the first scan…";
    double at; try { at = Convert.ToDouble(got["at"]); } catch { return ""; }
    var age = Math.Max(0, Math.Round(((DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds - at) / 1000));
    return age < 60 ? "Updated " + age + " s ago" : "Last update " + Math.Round(age / 60) + " min ago — scanner stalled?";
  }

  /** Claude 桌面应用的主窗口：进程名 claude、Chromium 顶层窗口、可见、有标题；有几个就取最前面的。 */
  static IntPtr FindClaude() {
    IntPtr best = IntPtr.Zero; var fg = Native.GetForegroundWindow();
    var claude = new HashSet<uint>(Process.GetProcessesByName("claude").Select(p => (uint)p.Id));
    Native.EnumWindows((h, l) => {
      if (!Native.IsWindowVisible(h)) return true;
      uint pid; Native.GetWindowThreadProcessId(h, out pid);
      if (!claude.Contains(pid)) return true;
      var cls = new StringBuilder(64); Native.GetClassName(h, cls, 64);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      var title = new StringBuilder(256); Native.GetWindowText(h, title, 256);
      if (title.Length == 0) return true;
      if (best == IntPtr.Zero || h == fg) best = h;   // EnumWindows 按 z 序从上往下：第一个 = 最上面的
      return h != fg;
    }, IntPtr.Zero);
    return best;
  }

  /** 每半秒：找 Claude 窗口（换了窗口就重新挂上、重新订阅事件），再摆一次（兜底，平时靠事件）。 */
  void Follow() {
    if (owner == IntPtr.Zero || !Native.IsWindow(owner) || !Native.IsWindowVisible(owner)) {
      var h = FindClaude();
      if (h != owner) { owner = h; if (h != IntPtr.Zero) { pill.Own(h); menu.Own(h); Hook(h); } }
    }
    Place();
  }

  /** 订阅 Claude 窗口所在进程的位置变化（0x800B）和最小化开始 / 结束（0x16、0x17）。 */
  void Hook(IntPtr h) {
    uint pid; Native.GetWindowThreadProcessId(h, out pid);
    if (pid == hookedPid) return;
    foreach (var k in hooks) Native.UnhookWinEvent(k);
    hooks.Clear(); hookedPid = pid;
    hooks.Add(Native.SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, hookProc, pid, 0, 0));
    hooks.Add(Native.SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, hookProc, pid, 0, 0));
  }

  /** 摆到 Claude 窗口标题栏右侧；最小化 / 关掉 / 在别的虚拟桌面 / 太窄时藏起来。 */
  void Place() {
    var r = new Native.RECT(); int cloaked = 0;
    bool show = owner != IntPtr.Zero && !Native.IsIconic(owner)
      && Native.DwmGetWindowAttribute(owner, 9 /* EXTENDED_FRAME_BOUNDS */, out r, Marshal.SizeOf(typeof(Native.RECT))) == 0
      && !(Native.DwmGetWindowAttribute(owner, 14 /* CLOAKED */, out cloaked, 4) == 0 && cloaked != 0);
    if (!show) { if (pill.Visible) pill.Hide(); if (menu.Visible) menu.Hide(); return; }
    float s = Native.GetDpiForWindow(owner) / 96f; if (s <= 0) s = 1;
    if (r.Right - r.Left < MIN_WIDTH * s) { if (pill.Visible) pill.Hide(); if (menu.Visible) menu.Hide(); return; }
    if (Math.Abs(s - pill.Zoom) > 0.01 || pillW < 0) { pill.Zoom = s; menu.Zoom = s; pillW = pill.Measure(); }
    if ((DateTime.UtcNow - themeAt).TotalSeconds > 5) { themeAt = DateTime.UtcNow; SampleTheme(r, s); }
    var w = pillW; var hgt = (int)(HEIGHT * s);
    var x = r.Right - (int)(RIGHT_GAP * s) - w; var y = r.Top + (int)(TOP * s);
    if (pill.Width != w || pill.Height != hgt) {
      pill.SetBounds(x, y, w, hgt);
      using (var path = Draw.Round(new RectangleF(0, 0, w, hgt), 6 * s)) pill.Region = new Region(path);
      pill.Invalidate();
    } else if (pill.Left != x || pill.Top != y) {
      Native.SetWindowPos(pill.Handle, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010);   // NOSIZE | NOZORDER | NOACTIVATE：只挪不重画
    }
    if (!pill.Visible) { pill.Show(); pill.Own(owner); }
    if (menu.Visible) PlaceMenu();
  }

  /** 标题栏空白处取一个像素：亮 = 浅色主题。 */
  void SampleTheme(Native.RECT r, float s) {
    try {
      using (var bmp = new Bitmap(1, 1)) using (var g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(r.Right - (int)((RIGHT_GAP + 120) * s), r.Top + (int)(3 * s), 0, 0, new Size(1, 1));
        var c = bmp.GetPixel(0, 0);
        theme.Dark = c.R * 0.299 + c.G * 0.587 + c.B * 0.114 < 128;
      }
    } catch { }
  }

  void PlaceMenu() {
    var x = pill.Right - menu.Width; var y = pill.Bottom + (int)(6 * menu.Zoom);
    var screen = Screen.FromControl(pill).WorkingArea;
    x = Math.Max(screen.Left, Math.Min(x, screen.Right - menu.Width));
    if (menu.Left != x || menu.Top != y) Native.SetWindowPos(menu.Handle, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010);
  }

  void Toggle() {
    if (menu.Visible) { menu.Hide(); return; }
    if ((DateTime.UtcNow - menu.ClosedAt).TotalMilliseconds < 300) return;   // 点胶囊让菜单失焦关掉的那一下，不要又打开
    Tick();
    menu.Fill(rows, Footer());
    PlaceMenu();
    menu.Show(); menu.Own(owner); menu.Activate();
  }
}
}
