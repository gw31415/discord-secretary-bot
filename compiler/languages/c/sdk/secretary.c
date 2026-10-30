#include "secretary.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((import_module("secretary"), import_name("call")))
extern int secretary_host_call(const char *request, unsigned request_length, char *answer, unsigned capacity);

char *secretary_read_stdin(size_t *length) {
  size_t cap = 64 * 1024, len = 0;
  char *buf = malloc(cap + 1);
  size_t n;
  while (buf && (n = fread(buf + len, 1, cap - len, stdin)) > 0) {
    len += n;
    if (len == cap) {
      cap *= 2;
      buf = realloc(buf, cap + 1);
    }
  }
  if (!buf) return NULL;
  buf[len] = 0;
  if (length) *length = len;
  return buf;
}

char *secretary_call_raw(const char *request, size_t length) {
  unsigned cap = 64 * 1024;
  char *buf = malloc(cap + 1);
  for (;;) {
    if (!buf) return NULL;
    int n = secretary_host_call(request, (unsigned)length, buf, cap);
    if (n < 0) { /* too small: the answer needs -n bytes */
      cap = (unsigned)-n;
      buf = realloc(buf, cap + 1);
      continue;
    }
    buf[n] = 0;
    return buf;
  }
}

static void set_error(char **error, const char *message) {
  if (error) *error = strdup(message);
}

cJSON *secretary_input(void) {
  size_t len;
  char *raw = secretary_read_stdin(&len);
  if (!raw) return NULL;
  cJSON *input = cJSON_ParseWithLength(raw, len);
  free(raw);
  return input;
}

cJSON *secretary_call(const cJSON *request, char **error) {
  char *req = cJSON_PrintUnformatted(request);
  if (!req) {
    set_error(error, "request is not JSON");
    return NULL;
  }
  char *raw = secretary_call_raw(req, strlen(req));
  free(req);
  cJSON *answer = raw ? cJSON_Parse(raw) : NULL;
  free(raw);
  if (!answer) {
    set_error(error, "the host's answer is not JSON");
    return NULL;
  }
  const cJSON *err = cJSON_GetObjectItemCaseSensitive(answer, "error");
  if (cJSON_IsString(err)) {
    set_error(error, err->valuestring);
    cJSON_Delete(answer);
    return NULL;
  }
  cJSON *value = cJSON_DetachItemFromObjectCaseSensitive(answer, "value");
  cJSON_Delete(answer);
  return value ? value : cJSON_CreateNull();
}

cJSON *secretary_get(const char *route, char **error) {
  return secretary_get_query(route, NULL, error);
}

cJSON *secretary_get_query(const char *route, const cJSON *query, char **error) {
  cJSON *req = cJSON_CreateObject();
  cJSON_AddStringToObject(req, "fn", "get");
  cJSON_AddStringToObject(req, "route", route);
  if (query) cJSON_AddItemToObject(req, "query", cJSON_Duplicate(query, 1));
  cJSON *value = secretary_call(req, error);
  cJSON_Delete(req);
  return value;
}

void secretary_output(const cJSON *result) {
  char *out = cJSON_PrintUnformatted(result);
  if (out) {
    fputs(out, stdout);
    free(out);
  }
}
