/*
 * The JavaScript engine as a Wasm module. Rule and agent code is JavaScript;
 * it runs here, inside QuickJS compiled to WASI, under the same sandbox and
 * ABI as any uploaded module: the only way out is secretary.call.
 *
 * stdin: one line of JSON (the header), the program (`size` bytes), then the
 * run's input: the same JSON object every module reads on stdin.
 *   {"mode":"compile","size":N}  program = source; stdout = QuickJS bytecode
 *   {"mode":"source","size":N}   program = source
 *   {"mode":"bytecode","size":N} program = bytecode from "compile"
 * In the run modes each key of the input becomes a global, and stdout is the
 * program's string result, so a rule's program writes what any module writes.
 * A thrown error (or a syntax error) goes to stderr as "Name: message" and
 * the exit code is 1, as with any module that fails.
 * Inside, __host(string) sends a request to the bot and returns its answer,
 * and __log(string) writes one line to stderr (the run's logs).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

__attribute__((import_module("secretary"), import_name("call")))
int32_t host_call(const uint8_t *req, uint32_t req_len, uint8_t *resp, uint32_t resp_cap);

static uint8_t *read_all(size_t *len) {
  size_t cap = 1 << 16, n = 0;
  uint8_t *buf = malloc(cap);
  for (;;) {
    if (n == cap) buf = realloc(buf, cap *= 2);
    size_t got = fread(buf + n, 1, cap - n, stdin);
    if (got == 0) break;
    n += got;
  }
  *len = n;
  return buf;
}

static JSValue js_host(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  size_t req_len;
  const char *req = JS_ToCStringLen(ctx, &req_len, argv[0]);
  if (!req) return JS_EXCEPTION;
  uint32_t cap = 64 * 1024;
  uint8_t *resp = malloc(cap);
  int32_t n = host_call((const uint8_t *)req, req_len, resp, cap);
  if (n < 0) {
    cap = (uint32_t)(-n);
    resp = realloc(resp, cap);
    n = host_call((const uint8_t *)req, req_len, resp, cap);
  }
  JS_FreeCString(ctx, req);
  JSValue out = n < 0 ? JS_ThrowInternalError(ctx, "host answer did not fit") : JS_NewStringLen(ctx, (const char *)resp, (size_t)n);
  free(resp);
  return out;
}

static JSValue js_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
  if (!s) return JS_EXCEPTION;
  fwrite(s, 1, len, stderr);
  fputc('\n', stderr);
  JS_FreeCString(ctx, s);
  return JS_UNDEFINED;
}

/* "Name: message" of the pending exception. */
static char *exception_text(JSContext *ctx) {
  JSValue e = JS_GetException(ctx);
  const char *text = NULL;
  char *out;
  if (JS_IsObject(e)) {
    JSValue name = JS_GetPropertyStr(ctx, e, "name"), message = JS_GetPropertyStr(ctx, e, "message");
    const char *n = JS_ToCString(ctx, name), *m = JS_ToCString(ctx, message);
    size_t len = strlen(n ? n : "Error") + strlen(m ? m : "") + 3;
    out = malloc(len);
    snprintf(out, len, "%s: %s", n ? n : "Error", m ? m : "");
    if (n) JS_FreeCString(ctx, n);
    if (m) JS_FreeCString(ctx, m);
    JS_FreeValue(ctx, name);
    JS_FreeValue(ctx, message);
  } else {
    text = JS_ToCString(ctx, e);
    out = strdup(text ? text : "unknown error");
    if (text) JS_FreeCString(ctx, text);
  }
  JS_FreeValue(ctx, e);
  return out;
}

static int fail(JSContext *ctx) {
  char *text = exception_text(ctx);
  fprintf(stderr, "%s\n", text);
  return 1;
}

int main(void) {
  size_t len;
  uint8_t *input = read_all(&len);
  uint8_t *nl = memchr(input, '\n', len);
  if (!nl) {
    fputs("missing header\n", stderr);
    return 2;
  }
  size_t header_len = (size_t)(nl - input);
  uint8_t *program = nl + 1;
  size_t rest = len - header_len - 1;

  JSRuntime *rt = JS_NewRuntime();
  JS_SetMaxStackSize(rt, 768 * 1024);
  /* The JS heap's own limit, below the module's memory cap, so running out is a catchable error. */
  JS_SetMemoryLimit(rt, 48 * 1024 * 1024);
  JSContext *ctx = JS_NewContext(rt);
  JSValue global = JS_GetGlobalObject(ctx);

  *nl = 0; /* the parser reads up to a NUL */
  JSValue header = JS_ParseJSON(ctx, (const char *)input, header_len, "header");
  JSValue mode_v = JS_GetPropertyStr(ctx, header, "mode");
  const char *mode = JS_ToCString(ctx, mode_v);
  double size_d = -1;
  JSValue size_v = JS_GetPropertyStr(ctx, header, "size");
  if (JS_IsNumber(size_v)) JS_ToFloat64(ctx, &size_d, size_v);
  if (!mode || size_d < 0 || (size_t)size_d > rest) {
    fputs("bad header\n", stderr);
    return 2;
  }
  size_t program_len = (size_t)size_d;
  uint8_t *run_input = program + program_len;
  size_t run_input_len = rest - program_len;
  int is_source = strcmp(mode, "bytecode") != 0;
  char *source = NULL;
  if (is_source) {
    /* The source must end in NUL for the parser. */
    source = malloc(program_len + 1);
    memcpy(source, program, program_len);
    source[program_len] = 0;
  }

  if (strcmp(mode, "compile") == 0) {
    JSValue fn = JS_Eval(ctx, source, program_len, "code.js", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(fn)) return fail(ctx);
    size_t size;
    uint8_t *bytecode = JS_WriteObject(ctx, &size, fn, JS_WRITE_OBJ_BYTECODE);
    fwrite(bytecode, 1, size, stdout);
    return 0;
  }

  /* The run's input, as globals. */
  char *json = malloc(run_input_len + 1);
  memcpy(json, run_input, run_input_len);
  json[run_input_len] = 0;
  JSValue values = JS_ParseJSON(ctx, json, run_input_len, "input");
  if (!JS_IsObject(values)) {
    fputs("the input is not a JSON object\n", stderr);
    return 2;
  }
  JSPropertyEnum *props;
  uint32_t count;
  if (JS_GetOwnPropertyNames(ctx, &props, &count, values, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
    for (uint32_t i = 0; i < count; i++) {
      JS_SetProperty(ctx, global, props[i].atom, JS_GetProperty(ctx, values, props[i].atom));
    }
  }
  JS_SetPropertyStr(ctx, global, "__host", JS_NewCFunction(ctx, js_host, "__host", 1));
  JS_SetPropertyStr(ctx, global, "__log", JS_NewCFunction(ctx, js_log, "__log", 1));

  JSValue result;
  if (is_source) {
    result = JS_Eval(ctx, source, program_len, "code.js", JS_EVAL_TYPE_GLOBAL);
  } else {
    JSValue fn = JS_ReadObject(ctx, program, program_len, JS_READ_OBJ_BYTECODE);
    result = JS_IsException(fn) ? fn : JS_EvalFunction(ctx, fn);
  }
  if (JS_IsException(result)) return fail(ctx);
  size_t out_len;
  const char *out = JS_ToCStringLen(ctx, &out_len, result);
  if (out) fwrite(out, 1, out_len, stdout);
  return 0;
}
