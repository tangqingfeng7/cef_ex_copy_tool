param(
    [Parameter(Mandatory=$true)][ValidateSet('Encode','Decode')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateSet(4,5)][uint32]$Algorithm=5
)
$ErrorActionPreference='Stop'
# MSBuild may export nonexistent optional ATL paths; C# compilation needs no LIB.
$env:LIB=''
Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class CefResourceCodec {
    const int Limit = 16 * 1024 * 1024;
    [DllImport("cabinet.dll",SetLastError=true)] static extern bool CreateCompressor(uint algorithm,IntPtr allocation,out IntPtr handle);
    [DllImport("cabinet.dll",SetLastError=true)] static extern bool Compress(IntPtr handle,byte[] input,UIntPtr inputSize,byte[] output,UIntPtr outputSize,out UIntPtr written);
    [DllImport("cabinet.dll")] static extern bool CloseCompressor(IntPtr handle);
    [DllImport("cabinet.dll",SetLastError=true)] static extern bool CreateDecompressor(uint algorithm,IntPtr allocation,out IntPtr handle);
    [DllImport("cabinet.dll",SetLastError=true)] static extern bool Decompress(IntPtr handle,byte[] input,UIntPtr inputSize,byte[] output,UIntPtr outputSize,out UIntPtr written);
    [DllImport("cabinet.dll")] static extern bool CloseDecompressor(IntPtr handle);
    static Exception Error() { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    public static byte[] Encode(byte[] source, uint algorithm) {
        if(source.Length == 0 || source.Length > Limit) throw new InvalidDataException("Resource size limit");
        IntPtr h; if(!CreateCompressor(algorithm,IntPtr.Zero,out h)) throw Error();
        try {
            UIntPtr size;
            Compress(h,source,(UIntPtr)source.Length,null,UIntPtr.Zero,out size);
            int count=checked((int)size.ToUInt64());
            if(count <= 0 || count > Limit) throw new InvalidDataException("Compressed size limit");
            byte[] compressed=new byte[count];
            if(!Compress(h,source,(UIntPtr)source.Length,compressed,(UIntPtr)compressed.Length,out size)) throw Error();
            byte[] result=new byte[40+checked((int)size.ToUInt64())];
            result[0]=67;result[1]=88;result[2]=90;result[3]=49;
            Buffer.BlockCopy(BitConverter.GetBytes((uint)source.Length | (algorithm << 28)),0,result,4,4);
            using(var sha=SHA256.Create()) Buffer.BlockCopy(sha.ComputeHash(source),0,result,8,32);
            Buffer.BlockCopy(compressed,0,result,40,result.Length-40);
            return result;
        } finally { CloseCompressor(h); }
    }
    public static byte[] Decode(byte[] packet) {
        if(packet.Length < 41 || packet.Length > Limit || packet[0]!=67 || packet[1]!=88 || packet[2]!=90 || packet[3]!=49)
            throw new InvalidDataException("Invalid CXZ1 resource header");
        uint info=BitConverter.ToUInt32(packet,4);
        int size=(int)(info & 0x0fffffff);
        uint algorithm=info >> 28;
        if(algorithm==0) algorithm=4;
        if(algorithm!=4 && algorithm!=5) throw new InvalidDataException("Unknown compression algorithm");
        if(size<=0 || size>Limit) throw new InvalidDataException("Decoded size limit");
        byte[] compressed=new byte[packet.Length-40];Buffer.BlockCopy(packet,40,compressed,0,compressed.Length);
        byte[] output=new byte[size];IntPtr h;
        if(!CreateDecompressor(algorithm,IntPtr.Zero,out h)) throw Error();
        try {
            UIntPtr actual;
            if(!Decompress(h,compressed,(UIntPtr)compressed.Length,output,(UIntPtr)output.Length,out actual)) throw Error();
            if(actual.ToUInt64()!=(ulong)size) throw new InvalidDataException("Decoded length mismatch");
        } finally { CloseDecompressor(h); }
        using(var sha=SHA256.Create()) {
            byte[] hash=sha.ComputeHash(output);
            for(int i=0;i<32;i++)if(hash[i]!=packet[i+8])throw new InvalidDataException("Resource SHA256 mismatch");
        }
        return output;
    }
}
'@
$inputBytes=[IO.File]::ReadAllBytes([IO.Path]::GetFullPath($InputPath))
if($Mode -eq 'Encode'){$result=[CefResourceCodec]::Encode($inputBytes,$Algorithm)}else{$result=[CefResourceCodec]::Decode($inputBytes)}
[IO.File]::WriteAllBytes([IO.Path]::GetFullPath($OutputPath),$result)
