// The module's entry point: sets up MicroPython, runs main.mpy as __main__ and
// turns an uncaught exception into a traceback on stderr and exit code 1.
//
// The user's files are .mpy (compiled by mpy-cross when the module is built)
// linked in as secretary_files[] (files.c, generated per build). Imports read
// them from there; there is no file system.
//
// print() and sys.stdout go to stderr (the run's log): stdout belongs to the
// result, which the SDK writes with _secretary.write_stdout.
//
// GC: values held only in wasm locals are invisible to a conservative scan, so
// the linked module goes through binaryen's --spill-pointers, which keeps every
// pointer-sized local that lives across a call on the C stack in linear
// memory. gc_collect() then scans that stack.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

#include "py/builtin.h"
#include "py/compile.h"
#include "py/cstack.h"
#include "py/gc.h"
#include "py/lexer.h"
#include "py/mperrno.h"
#include "py/mphal.h"
#include "py/objstr.h"
#include "py/persistentcode.h"
#include "py/reader.h"
#include "py/runtime.h"
#include "py/stackctrl.h"

typedef struct {
    const char *path;
    const unsigned char *data;
    unsigned int len;
} secretary_file_t;

extern const secretary_file_t secretary_files[];
extern const unsigned int secretary_file_count;

// The heap starts small (a short run stays cheap to start) and grows, after a
// collection fails to free enough, up to HEAP_LIMIT in all (MICROPY_GC_SPLIT_HEAP_AUTO).
#ifndef HEAP_BYTES
#define HEAP_BYTES (1024 * 1024)
#endif
#ifndef HEAP_LIMIT
#define HEAP_LIMIT (48 * 1024 * 1024)
#endif
// The linker gives the C stack 1 MiB; leave room for C frames below Python's check.
#define STACK_LIMIT (1024 * 1024 - 128 * 1024)

__attribute__((import_module("secretary"), import_name("call")))
extern int secretary_host_call(const char *request, unsigned int request_length, char *answer, unsigned int capacity);

static char *stack_top;

static const secretary_file_t *find_file(const char *path) {
    for (unsigned int i = 0; i < secretary_file_count; i++) {
        if (strcmp(secretary_files[i].path, path) == 0) {
            return &secretary_files[i];
        }
    }
    return NULL;
}

mp_import_stat_t mp_import_stat(const char *path) {
    if (find_file(path)) {
        return MP_IMPORT_STAT_FILE;
    }
    size_t n = strlen(path);
    for (unsigned int i = 0; i < secretary_file_count; i++) {
        const char *p = secretary_files[i].path;
        if (strncmp(p, path, n) == 0 && p[n] == '/') {
            return MP_IMPORT_STAT_DIR;
        }
    }
    return MP_IMPORT_STAT_NO_EXIST;
}

void mp_reader_new_file(mp_reader_t *reader, qstr filename) {
    const secretary_file_t *f = find_file(qstr_str(filename));
    if (!f) {
        mp_raise_OSError(MP_ENOENT);
    }
    mp_reader_new_mem(reader, f->data, f->len, MP_READER_IS_ROM);
}

mp_lexer_t *mp_lexer_new_from_file(qstr filename) {
    // Only .mpy files are linked in, so there is never a source file to read.
    (void)filename;
    mp_raise_OSError(MP_ENOENT);
}

static mp_obj_t builtin_open(size_t n_args, const mp_obj_t *args, mp_map_t *kwargs) {
    (void)n_args;
    (void)args;
    (void)kwargs;
    mp_raise_msg(&mp_type_OSError, MP_ERROR_TEXT("there are no files"));
}
MP_DEFINE_CONST_FUN_OBJ_KW(mp_builtin_open_obj, 1, builtin_open);

mp_uint_t mp_hal_stdout_tx_strn(const char *str, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = write(2, str + done, len - done);
        if (n <= 0) {
            break;
        }
        done += n;
    }
    return done;
}

void mp_hal_stdout_tx_strn_cooked(const char *str, size_t len) {
    mp_hal_stdout_tx_strn(str, len);
}

uintptr_t mp_hal_stdio_poll(uintptr_t poll_flags) {
    (void)poll_flags;
    return 0;
}

void mp_hal_delay_ms(mp_uint_t ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000 };
    nanosleep(&ts, NULL);
}

void mp_hal_delay_us(mp_uint_t us) {
    struct timespec ts = { us / 1000000, (us % 1000000) * 1000 };
    nanosleep(&ts, NULL);
}

uint32_t secretary_random_seed(void) {
    uint32_t seed = 0;
    getentropy(&seed, sizeof(seed));
    return seed;
}

size_t gc_get_max_new_split(void) {
    size_t total = 0;
    for (mp_state_mem_area_t *area = &MP_STATE_MEM(area); area != NULL; area = area->next) {
        total += (uintptr_t)area->gc_pool_end - (uintptr_t)area->gc_alloc_table_start;
    }
    return total < HEAP_LIMIT ? HEAP_LIMIT - total : 0;
}

void gc_collect(void) {
    gc_collect_start();
    volatile void *here = NULL;
    void **sp = (void **)((uintptr_t)&here & ~(uintptr_t)(sizeof(void *) - 1));
    gc_collect_root(sp, ((uintptr_t)stack_top - (uintptr_t)sp) / sizeof(void *));
    gc_collect_end();
}

void nlr_jump_fail(void *val) {
    (void)val;
    static const char msg[] = "FATAL: uncaught NLR\n";
    write(2, msg, sizeof(msg) - 1);
    abort();
}

#ifndef NDEBUG
void MP_WEAK __assert_func(const char *file, int line, const char *func, const char *expr) {
    fprintf(stderr, "assert %s:%d %s: %s\n", file, line, func, expr);
    abort();
}
#endif

// ---- _secretary: the raw host interface the secretary module is built on ----

static mp_obj_t secretary_read_stdin(void) {
    size_t cap = 64 * 1024, len = 0;
    char *buf = malloc(cap);
    for (;;) {
        if (!buf) {
            mp_raise_type(&mp_type_MemoryError);
        }
        ssize_t n = read(0, buf + len, cap - len);
        if (n <= 0) {
            break;
        }
        len += n;
        if (len == cap) {
            cap *= 2;
            char *grown = realloc(buf, cap);
            if (!grown) {
                free(buf);
            }
            buf = grown;
        }
    }
    mp_obj_t s = mp_obj_new_str(buf, len);
    free(buf);
    return s;
}
static MP_DEFINE_CONST_FUN_OBJ_0(secretary_read_stdin_obj, secretary_read_stdin);

static mp_obj_t secretary_call(mp_obj_t request) {
    size_t req_len;
    const char *req = mp_obj_str_get_data(request, &req_len);
    unsigned int cap = 64 * 1024;
    char *buf = malloc(cap);
    for (;;) {
        if (!buf) {
            mp_raise_type(&mp_type_MemoryError);
        }
        int n = secretary_host_call(req, (unsigned int)req_len, buf, cap);
        if (n >= 0) {
            mp_obj_t s = mp_obj_new_str(buf, (size_t)n);
            free(buf);
            return s;
        }
        // Too small: the answer needs -n bytes.
        cap = (unsigned int)-n;
        free(buf);
        buf = malloc(cap);
    }
}
static MP_DEFINE_CONST_FUN_OBJ_1(secretary_call_obj, secretary_call);

static mp_obj_t secretary_write_stdout(mp_obj_t data) {
    size_t len;
    const char *p = mp_obj_str_get_data(data, &len);
    while (len > 0) {
        ssize_t n = write(1, p, len);
        if (n <= 0) {
            mp_raise_OSError(MP_EIO);
        }
        p += n;
        len -= n;
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(secretary_write_stdout_obj, secretary_write_stdout);

static const mp_rom_map_elem_t secretary_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR__secretary) },
    { MP_ROM_QSTR(MP_QSTR_read_stdin), MP_ROM_PTR(&secretary_read_stdin_obj) },
    { MP_ROM_QSTR(MP_QSTR_call), MP_ROM_PTR(&secretary_call_obj) },
    { MP_ROM_QSTR(MP_QSTR_write_stdout), MP_ROM_PTR(&secretary_write_stdout_obj) },
};
static MP_DEFINE_CONST_DICT(secretary_module_globals, secretary_module_globals_table);

const mp_obj_module_t secretary_module = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&secretary_module_globals,
};
MP_REGISTER_MODULE(MP_QSTR__secretary, secretary_module);

// ---- entry point ----

static int run_main(void) {
    const secretary_file_t *f = find_file("main.mpy");
    if (!f) {
        static const char msg[] = "main.py がありません\n";
        write(2, msg, sizeof(msg) - 1);
        return 1;
    }
    int status = 0;
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_module_context_t *ctx = m_new_obj(mp_module_context_t);
        ctx->module.globals = mp_globals_get();
        mp_compiled_module_t cm;
        cm.context = ctx;
        mp_raw_code_load_mem(f->data, f->len, &cm);
        mp_obj_t fun = mp_make_function_from_proto_fun(cm.rc, ctx, NULL);
        mp_call_function_0(fun);
        nlr_pop();
    } else {
        mp_obj_t exc = MP_OBJ_FROM_PTR(nlr.ret_val);
        if (mp_obj_is_subclass_fast(MP_OBJ_FROM_PTR(mp_obj_get_type(exc)), MP_OBJ_FROM_PTR(&mp_type_SystemExit))) {
            mp_obj_t value = mp_obj_exception_get_value(exc);
            mp_int_t code;
            if (value == mp_const_none) {
                status = 0;
            } else if (mp_obj_get_int_maybe(value, &code)) {
                status = (int)code & 0xff;
            } else {
                mp_obj_print_helper(&mp_plat_print, value, PRINT_STR);
                mp_hal_stdout_tx_strn("\n", 1);
                status = 1;
            }
        } else {
            mp_obj_print_exception(&mp_plat_print, exc);
            status = 1;
        }
    }
    return status;
}

int main(void) {
    char top;
    stack_top = &top;
    mp_cstack_init_with_top(stack_top, STACK_LIMIT);
    char *heap = malloc(HEAP_BYTES);
    if (!heap) {
        return 1;
    }
    gc_init(heap, heap + HEAP_BYTES);
    mp_init();
    mp_obj_list_append(mp_sys_path, MP_OBJ_NEW_QSTR(MP_QSTR_));
    int status = run_main();
    mp_deinit();
    return status;
}
