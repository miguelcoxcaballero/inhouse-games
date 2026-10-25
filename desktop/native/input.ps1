# Inhouse Link — original Windows input transport. Events arrive only on stdin.
# The Electron main process bounds and validates every event before forwarding it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class InhouseInput {
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
        public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra;
    }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static InhouseInput() {
        // Match Electron's physical display rectangle on mixed-DPI Windows desktops.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    }

    static readonly Dictionary<string, int> Keys = new Dictionary<string, int> {
        {"Escape",0x01},{"Digit1",0x02},{"Digit2",0x03},{"Digit3",0x04},{"Digit4",0x05},{"Digit5",0x06},
        {"Digit6",0x07},{"Digit7",0x08},{"Digit8",0x09},{"Digit9",0x0A},{"Digit0",0x0B},{"Minus",0x0C},
        {"Equal",0x0D},{"Backspace",0x0E},{"Tab",0x0F},{"KeyQ",0x10},{"KeyW",0x11},{"KeyE",0x12},
        {"KeyR",0x13},{"KeyT",0x14},{"KeyY",0x15},{"KeyU",0x16},{"KeyI",0x17},{"KeyO",0x18},
        {"KeyP",0x19},{"BracketLeft",0x1A},{"BracketRight",0x1B},{"Enter",0x1C},{"ControlLeft",0x1D},
        {"KeyA",0x1E},{"KeyS",0x1F},{"KeyD",0x20},{"KeyF",0x21},{"KeyG",0x22},{"KeyH",0x23},
        {"KeyJ",0x24},{"KeyK",0x25},{"KeyL",0x26},{"Semicolon",0x27},{"Quote",0x28},{"Backquote",0x29},
        {"ShiftLeft",0x2A},{"Backslash",0x2B},{"KeyZ",0x2C},{"KeyX",0x2D},{"KeyC",0x2E},{"KeyV",0x2F},
        {"KeyB",0x30},{"KeyN",0x31},{"KeyM",0x32},{"Comma",0x33},{"Period",0x34},{"Slash",0x35},
        {"ShiftRight",0x36},{"NumpadMultiply",0x37},{"AltLeft",0x38},{"Space",0x39},{"CapsLock",0x3A},
        {"F1",0x3B},{"F2",0x3C},{"F3",0x3D},{"F4",0x3E},{"F5",0x3F},{"F6",0x40},{"F7",0x41},
        {"F8",0x42},{"F9",0x43},{"F10",0x44},{"NumLock",0x45},{"ScrollLock",0x46},{"Numpad7",0x47},
        {"Numpad8",0x48},{"Numpad9",0x49},{"NumpadSubtract",0x4A},{"Numpad4",0x4B},{"Numpad5",0x4C},
        {"Numpad6",0x4D},{"NumpadAdd",0x4E},{"Numpad1",0x4F},{"Numpad2",0x50},{"Numpad3",0x51},
        {"Numpad0",0x52},{"NumpadDecimal",0x53},{"IntlBackslash",0x56},{"F11",0x57},{"F12",0x58},
        {"F13",0x64},{"F14",0x65},{"F15",0x66},{"F16",0x67},{"F17",0x68},{"F18",0x69},{"F19",0x6A},
        {"F20",0x6B},{"F21",0x6C},{"F22",0x6D},{"F23",0x6E},{"F24",0x76},
        {"NumpadEnter",0x11C},{"ControlRight",0x11D},{"NumpadDivide",0x135},{"PrintScreen",0x137},
        {"AltRight",0x138},{"Home",0x147},{"ArrowUp",0x148},{"PageUp",0x149},{"ArrowLeft",0x14B},
        {"ArrowRight",0x14D},{"End",0x14F},{"ArrowDown",0x150},{"PageDown",0x151},{"Insert",0x152},
        {"Delete",0x153},{"MetaLeft",0x15B},{"MetaRight",0x15C},{"ContextMenu",0x15D}
    };
    static readonly HashSet<string> HeldKeys = new HashSet<string>();
    static readonly HashSet<int> HeldButtons = new HashSet<int>();
    static int left, top, width = 1, height = 1;

    static void Dispatch(INPUT input) {
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("Windows rejected input");
    }
    static void Mouse(int x, int y, uint data, uint flags) {
        INPUT input = new INPUT(); input.type = 0;
        input.data.mouse = new MOUSEINPUT { dx=x, dy=y, mouseData=data, flags=flags };
        Dispatch(input);
    }
    public static void Bounds(int x, int y, int w, int h) {
        if (w < 1 || h < 1 || w > 65536 || h > 65536) return;
        left=x; top=y; width=w; height=h;
    }
    public static void Pointer(double x, double y) {
        if (Double.IsNaN(x) || Double.IsNaN(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        int vx=GetSystemMetrics(76), vy=GetSystemMetrics(77);
        int vw=Math.Max(2,GetSystemMetrics(78)), vh=Math.Max(2,GetSystemMetrics(79));
        int px=left+(int)Math.Round(x*(width-1)), py=top+(int)Math.Round(y*(height-1));
        int nx=(int)Math.Round((px-vx)*65535.0/(vw-1)), ny=(int)Math.Round((py-vy)*65535.0/(vh-1));
        Mouse(Math.Max(0,Math.Min(65535,nx)),Math.Max(0,Math.Min(65535,ny)),0,0x0001|0x4000|0x8000);
    }
    public static void Relative(int x, int y) {
        if (Math.Abs(x) > 2048 || Math.Abs(y) > 2048) return;
        Mouse(x,y,0,0x0001);
    }
    public static void Button(int button, bool down) {
        uint flag;
        switch(button) {
            case 0: flag=down?0x0002u:0x0004u; break;
            case 1: flag=down?0x0020u:0x0040u; break;
            case 2: flag=down?0x0008u:0x0010u; break;
            default: return;
        }
        if (down && !HeldButtons.Add(button)) return;
        if (!down) HeldButtons.Remove(button);
        Mouse(0,0,0,flag);
    }
    public static void Wheel(int x, int y) {
        if (Math.Abs(x)>1200 || Math.Abs(y)>1200) return;
        if (y!=0) Mouse(0,0,unchecked((uint)-y),0x0800);
        if (x!=0) Mouse(0,0,unchecked((uint)x),0x1000);
    }
    public static void Key(string code, bool down) {
        int value;
        if (code==null || !Keys.TryGetValue(code,out value)) return;
        // Browser keydown repeats represent real repeated keystrokes. Keep the
        // set for cleanup, but forward every repeat to Windows.
        if (down) HeldKeys.Add(code);
        if (!down) HeldKeys.Remove(code);
        INPUT input=new INPUT(); input.type=1;
        input.data.keyboard=new KEYBDINPUT { scan=(ushort)(value&0xff), flags=0x0008u|(value>0xff?0x0001u:0u)|(down?0u:0x0002u) };
        Dispatch(input);
    }
    public static void Release() {
        foreach(string key in new List<string>(HeldKeys)) { try { Key(key,false); } catch {} }
        foreach(int button in new List<int>(HeldButtons)) { try { Button(button,false); } catch {} }
        HeldKeys.Clear(); HeldButtons.Clear();
    }
}
'@

[Console]::Out.WriteLine('INHOUSE_INPUT_READY')
[Console]::Out.Flush()
try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line.Length -gt 4096) { continue }
        try {
            $event = $line | ConvertFrom-Json
            switch ($event.kind) {
                'bounds' { [InhouseInput]::Bounds([int]$event.x, [int]$event.y, [int]$event.width, [int]$event.height) }
                'pointer' { [InhouseInput]::Pointer([double]$event.x, [double]$event.y) }
                'relative' { [InhouseInput]::Relative([int]$event.dx, [int]$event.dy) }
                'button' { [InhouseInput]::Button([int]$event.button, [bool]$event.down) }
                'wheel' { [InhouseInput]::Wheel([int]$event.dx, [int]$event.dy) }
                'key' { [InhouseInput]::Key([string]$event.code, [bool]$event.down) }
                'release' { [InhouseInput]::Release() }
                'quit' { return }
            }
        } catch { [InhouseInput]::Release() }
    }
} finally { [InhouseInput]::Release() }
