/* The bot's side of the ABI for C and C++: read the run's input, call the
 * host, write the result. JSON goes through cJSON (cJSON.h is on the include
 * path). Every function that returns a pointer hands it to the caller. */
#ifndef SECRETARY_H
#define SECRETARY_H
#include <stddef.h>
#include "cJSON.h"
#ifdef __cplusplus
extern "C" {
#endif

/* The run's input: { guild, actor, eventName, event, batch, params, state }. NULL if stdin is not JSON. */
cJSON *secretary_input(void);

/* Sends one request such as {"fn":"get","route":"/guilds/1"} and returns its value.
 * On failure returns NULL and, when error is not NULL, sets *error (free it). */
cJSON *secretary_call(const cJSON *request, char **error);

/* GET a Discord route the rule's owner may read. */
cJSON *secretary_get(const char *route, char **error);

/* GET with a query string such as {"limit":1}; query may be NULL. The caller keeps query. */
cJSON *secretary_get_query(const char *route, const cJSON *query, char **error);

/* Writes the result { steps, state?, reply? } to stdout. */
void secretary_output(const cJSON *result);

/* The raw forms: stdin as bytes, and one request/answer as JSON text. */
char *secretary_read_stdin(size_t *length);
char *secretary_call_raw(const char *request, size_t length);

#ifdef __cplusplus
}
#endif
#endif
