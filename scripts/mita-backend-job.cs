// Windows-only process containment for mita-backend-control.ps1 (PowerShell 5.1).
// Assign the suspended npm command to the job BEFORE any child can be created.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class MitaBackendJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long PerProcess, PerJob; public uint Flags;
        public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT Basic; public IO_COUNTERS IO;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int Size; public string Reserved, Desktop, Title;
        public int X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
        public short Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO {
        public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT limits, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESSINFO process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr job, process;
    public MitaBackendJob(string cmdExe, string command, string cwd) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try {
            var limits = new EXTENDED_LIMIT();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            var startup = new STARTUPINFO(); startup.Size = Marshal.SizeOf(startup);
            PROCESSINFO child;
            if (!CreateProcess(cmdExe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                0x08000004, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
            process = child.Process;
            try {
                if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
                if (ResumeThread(child.Thread) == uint.MaxValue) throw new Win32Exception();
            } catch {
                // Only the suspended process created by this constructor; never an existing PID.
                TerminateProcess(process, 1); throw;
            } finally { CloseHandle(child.Thread); }
        } catch { Dispose(); throw; }
    }
    public bool HasExited { get { return WaitForSingleObject(process, 0) == 0; } }
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
