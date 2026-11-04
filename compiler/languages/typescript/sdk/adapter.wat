;; scriptc builds a WASI reactor; the bot runs commands. This module is merged
;; into it (build.sh, wasm-merge) and supplies what scriptc imports:
;; - _start runs the reactor's initializers; the program's top-level code runs
;;   in module_init, module_run is empty.
;; - scriptc.secretaryCall is secretary.call (the same four i32s and result).
;; - scriptc.secretaryOutput (output() in secretary.ts) writes the result to
;;   stdout. Everything else the program writes to stdout (console.log) goes
;;   to stderr, the run's log: build.sh renames the program's
;;   wasi_snapshot_preview1.fd_write import to scriptc.fd_write.
;; - scriptc.panic (an uncaught exception or a trap in the program) writes its
;;   message and a newline to stderr and exits with 1, so the run fails with that
;;   text as its reason.
(module
  (import "secretary" "call" (func $call (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "app" "memory" (memory 0))
  (import "app" "_initialize" (func $initialize))
  (import "app" "module_init" (func $init))
  (import "app" "module_run" (func $run))
  (import "app" "scriptc_alloc" (func $alloc (param i32) (result i32)))
  (global $scratch (mut i32) (i32.const 0))
  (func (export "secretaryCall") (param i32 i32 i32 i32) (result i32)
    (call $call (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "fd_write") (param $fd i32) (param $iovs i32) (param $n i32) (param $written i32) (result i32)
    (call $fd_write
      (select (i32.const 2) (local.get $fd) (i32.eq (local.get $fd) (i32.const 1)))
      (local.get $iovs) (local.get $n) (local.get $written)))
  (func (export "secretaryOutput") (param $ptr i32) (param $len i32)
    ;; An iovec and the written count, in the space _start set aside (scriptc
    ;; refuses scriptc_alloc during a callback).
    (local $io i32)
    (local.set $io (i32.add (global.get $scratch) (i32.const 32)))
    ;; fd_write may write less than asked; keep going until all of it is out.
    (block $done
      (loop $more
        (br_if $done (i32.eqz (local.get $len)))
        (i32.store (local.get $io) (local.get $ptr))
        (i32.store offset=4 (local.get $io) (local.get $len))
        (if (call $fd_write (i32.const 1) (local.get $io) (i32.const 1) (i32.add (local.get $io) (i32.const 8)))
          (then (call $proc_exit (i32.const 1))))
        (local.set $ptr (i32.add (local.get $ptr) (i32.load offset=8 (local.get $io))))
        (local.set $len (i32.sub (local.get $len) (i32.load offset=8 (local.get $io))))
        (br $more))))
  (func (export "panic") (param $ptr i32) (param $len i32)
    ;; The text is "\01" (a marker), the message, then "\1f" code "\1f" entry;
    ;; write the message and a newline. Two iovecs, the newline and the written
    ;; count go in the space _start set aside: allocating here could trap again.
    (local $io i32)
    (local $i i32)
    (if (i32.and (i32.ne (local.get $len) (i32.const 0)) (i32.lt_u (i32.load8_u (local.get $ptr)) (i32.const 32)))
      (then
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
        (local.set $len (i32.sub (local.get $len) (i32.const 1)))))
    (block $end
      (loop $scan
        (br_if $end (i32.ge_u (local.get $i) (local.get $len)))
        (br_if $end (i32.eq (i32.load8_u (i32.add (local.get $ptr) (local.get $i))) (i32.const 31)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (local.set $io (global.get $scratch))
    (if (local.get $io) (then
      (i32.store (local.get $io) (local.get $ptr))
      (i32.store offset=4 (local.get $io) (local.get $i))
      (i32.store offset=8 (local.get $io) (i32.add (local.get $io) (i32.const 16)))
      (i32.store offset=12 (local.get $io) (i32.const 1))
      (i32.store8 offset=16 (local.get $io) (i32.const 10))
      (drop (call $fd_write (i32.const 2) (local.get $io) (i32.const 2) (i32.add (local.get $io) (i32.const 20))))))
    (call $proc_exit (i32.const 1))
    unreachable)
  (func (export "_start")
    (call $initialize)
    (global.set $scratch (call $alloc (i32.const 48)))
    (call $init)
    (call $run)))
