// MicroPython for the bot: a WASI preview 1 command (wasm32-wasip1) whose only
// outside world is stdin, stdout, stderr, the clock, random numbers and
// secretary.call. No files, no VFS, no REPL. The user's code comes in as .mpy
// files linked into the module (see main.c).
#include <stdint.h>
#include <alloca.h>
#include <stdlib.h>

#define MICROPY_CONFIG_ROM_LEVEL (MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES)

// Runtime
#define MICROPY_ENABLE_COMPILER (1)
#define MICROPY_ENABLE_GC (1)
#define MICROPY_GC_SPLIT_HEAP (1)
#define MICROPY_GC_SPLIT_HEAP_AUTO (1)
#define MICROPY_HELPER_REPL (0)
#define MICROPY_KBD_EXCEPTION (0)
#define MICROPY_STACK_CHECK (1)
#define MICROPY_ENABLE_EXTERNAL_IMPORT (1)
#define MICROPY_PERSISTENT_CODE_LOAD (1)
#define MICROPY_ENABLE_SOURCE_LINE (1)
#define MICROPY_ERROR_REPORTING (MICROPY_ERROR_REPORTING_DETAILED)
#define MICROPY_LONGINT_IMPL (MICROPY_LONGINT_IMPL_MPZ)
#define MICROPY_FLOAT_IMPL (MICROPY_FLOAT_IMPL_DOUBLE)
#define MICROPY_USE_INTERNAL_PRINTF (0)
#define MICROPY_ALLOC_PATH_MAX (256)
#define MICROPY_NLR_SETJMP (1)
#define MICROPY_VFS (0)
#define MICROPY_READER_VFS (0)
#define MICROPY_READER_POSIX (0)
// Imports read the linked-in files through mp_reader_new_file (main.c).
#define MICROPY_HAS_FILE_READER (1)

// Builtins and modules
#define MICROPY_PY_BUILTINS_STR_UNICODE (1)
#define MICROPY_PY_BUILTINS_HELP (0)
#define MICROPY_PY_BUILTINS_INPUT (0)
#define MICROPY_PY_SYS_STDFILES (1)
#define MICROPY_PY_SYS_EXIT (1)
#define MICROPY_PY_SYS_PATH (1)
#define MICROPY_PY_SYS_ARGV (1)
#define MICROPY_PY_SYS_PLATFORM "wasi"
#define MICROPY_PY_RE_SUB (1)
#define MICROPY_PY_RANDOM_EXTRA_FUNCS (1)
#define MICROPY_PY_RANDOM_SEED_INIT_FUNC (secretary_random_seed())
#define MICROPY_PY_TIME (1)
#define MICROPY_PY_TIME_TIME_TIME_NS (1)
#define MICROPY_PY_TIME_INCLUDEFILE "time_port.h"
#define MICROPY_PY_TIME_GMTIME_LOCALTIME_MKTIME (1)
#define MICROPY_EPOCH_IS_1970 (1)
#define MICROPY_PY_ASYNCIO (0)
#define MICROPY_PY_SELECT (0)
#define MICROPY_PY_OS (0)
#define MICROPY_PY_PLATFORM (0)
#define MICROPY_PY_UCTYPES (0)
#define MICROPY_PY_FRAMEBUF (0)
#define MICROPY_PY_DEFLATE (0)
#define MICROPY_PY_MACHINE (0)
#define MICROPY_PY_MARSHAL (0)

#define MICROPY_HW_BOARD_NAME "secretary"
#define MICROPY_HW_MCU_NAME "wasm32-wasip1"

#define MP_SSIZE_MAX (0x7fffffff)
typedef long mp_off_t;
#define MICROPY_MPHALPORT_H "mphalport.h"

uint32_t secretary_random_seed(void);
