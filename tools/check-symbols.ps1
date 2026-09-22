param([Parameter(Mandatory=$true)][string]$DllPath, [Parameter(Mandatory=$true)][string]$PdbPath)
$ErrorActionPreference = 'Stop'
# DbgHelp exposes the same PDB GUID/age for an image and its matching symbols.
# https://learn.microsoft.com/windows/win32/api/dbghelp/ns-dbghelp-symsrv_index_infow
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CefSymbolInfo {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Info {
        public uint sizeofstruct;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 261)] public string file;
        public int stripped;
        public uint timestamp, size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 261)] public string dbgfile;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 261)] public string pdbfile;
        public Guid guid;
        public uint sig, age;
    }
    [DllImport("dbghelp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SymSrvGetFileIndexInfoW(string file, ref Info info, uint flags);
    public static Info Read(string path) {
        var info = new Info();
        info.sizeofstruct = (uint)Marshal.SizeOf(typeof(Info));
        if (!SymSrvGetFileIndexInfoW(path, ref info, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read symbol identity: " + path);
        return info;
    }
}
'@
$taskDll = [CefSymbolInfo]::Read((Resolve-Path -LiteralPath $DllPath).Path)
$taskPdb = [CefSymbolInfo]::Read((Resolve-Path -LiteralPath $PdbPath).Path)
if ($taskDll.guid -eq [Guid]::Empty -or $taskDll.guid -ne $taskPdb.guid -or $taskDll.age -ne $taskPdb.age) {
    throw 'PDB does not match DLL; rebuild before packaging symbols.'
}
@{ guid = $taskDll.guid.ToString(); age = $taskDll.age } | ConvertTo-Json -Compress
