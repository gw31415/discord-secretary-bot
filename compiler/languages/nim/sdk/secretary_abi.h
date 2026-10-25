/* secretary.call, the one host import (see docs/wasm.md). */
#include <stdint.h>
__attribute__((import_module("secretary"), import_name("call")))
int32_t secretary_host_call(void *req, uint32_t req_len, void *resp, uint32_t resp_cap);
