// A seccomp filter for the build sandbox, handed to bubblewrap with --seccomp.
// Compilers need none of these calls; they are the ones that reach past a
// process's own files and children (debugging others, mounting, namespaces,
// kernel modules, BPF, keyrings, io_uring). Everything else is allowed.
// Classic BPF, written out here so the service needs no libseccomp.

const AUDIT_ARCH = { arm64: 0xc00000b7, x64: 0xc000003e } as const;

/** Numbers per architecture (asm-generic for arm64). */
const DENIED: Record<keyof typeof AUDIT_ARCH, Record<string, number>> = {
  arm64: {
    ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, pidfd_getfd: 438,
    mount: 40, umount2: 39, pivot_root: 41, chroot: 51, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
    unshare: 97, setns: 268,
    bpf: 280, perf_event_open: 241, userfaultfd: 282,
    keyctl: 219, add_key: 217, request_key: 218,
    init_module: 105, finit_module: 273, delete_module: 106, kexec_load: 104, kexec_file_load: 294,
    swapon: 224, swapoff: 225, reboot: 142, acct: 89, quotactl: 60, syslog: 116,
    open_by_handle_at: 265, name_to_handle_at: 264,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
  },
  x64: {
    ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, pidfd_getfd: 438,
    mount: 165, umount2: 166, pivot_root: 155, chroot: 161, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
    unshare: 272, setns: 308,
    bpf: 321, perf_event_open: 298, userfaultfd: 323,
    keyctl: 250, add_key: 248, request_key: 249,
    init_module: 175, finit_module: 313, delete_module: 176, kexec_load: 246, kexec_file_load: 320,
    swapon: 167, swapoff: 168, reboot: 169, acct: 163, quotactl: 179, syslog: 103,
    open_by_handle_at: 304, name_to_handle_at: 303,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
  },
};
/** clone3 answers ENOSYS, so libc falls back to clone (whose flags the sandbox already limits). */
const CLONE3 = 435;
const X32_BIT = 0x40000000;

const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

type Target = "eperm" | "enosys" | "kill";
interface Insn {
  code: number;
  k: number;
  jt?: Target | number;
  jf?: Target | number;
}

export function supportedArch(arch: string): arch is keyof typeof AUDIT_ARCH {
  return arch in AUDIT_ARCH;
}

/** The filter as struct sock_filter[] in host byte order (both supported architectures are little-endian). */
export function seccompFilter(arch: string = process.arch): Buffer {
  if (!supportedArch(arch)) throw new Error(`seccomp フィルタは ${arch} に対応していません`);
  const body: Insn[] = [
    { code: LD_W_ABS, k: OFFSET_ARCH },
    { code: JEQ_K, k: AUDIT_ARCH[arch], jt: 0, jf: "kill" },
    { code: LD_W_ABS, k: OFFSET_NR },
  ];
  if (arch === "x64") body.push({ code: JGE_K, k: X32_BIT, jt: "kill", jf: 0 });
  for (const nr of Object.values(DENIED[arch])) body.push({ code: JEQ_K, k: nr, jt: "eperm", jf: 0 });
  body.push({ code: JEQ_K, k: CLONE3, jt: "enosys", jf: 0 });
  body.push({ code: RET_K, k: RET_ALLOW });
  const labels: Record<Target, number> = { enosys: body.length, eperm: body.length + 1, kill: body.length + 2 };
  body.push({ code: RET_K, k: RET_ERRNO | ENOSYS }, { code: RET_K, k: RET_ERRNO | EPERM }, { code: RET_K, k: RET_KILL_PROCESS });
  const out = Buffer.alloc(body.length * 8);
  body.forEach((insn, pc) => {
    const jump = (j: Target | number | undefined): number => {
      if (j === undefined || typeof j === "number") return j ?? 0;
      const offset = labels[j] - (pc + 1);
      if (offset < 0 || offset > 255) throw new Error("seccomp フィルタのジャンプが遠すぎます");
      return offset;
    };
    out.writeUInt16LE(insn.code, pc * 8);
    out.writeUInt8(jump(insn.jt), pc * 8 + 2);
    out.writeUInt8(jump(insn.jf), pc * 8 + 3);
    out.writeUInt32LE(insn.k >>> 0, pc * 8 + 4);
  });
  return out;
}

export function deniedSyscalls(arch: string = process.arch): string[] {
  return supportedArch(arch) ? [...Object.keys(DENIED[arch]), "clone3"] : [];
}
