#include <stdio.h>
#include "secretary.h"

int main(void) {
  cJSON *in = secretary_input();
  const char *guild = cJSON_GetStringValue(cJSON_GetObjectItem(in, "guild"));
  char route[64];
  snprintf(route, sizeof route, "/guilds/%s", guild);
  char *error = NULL;
  cJSON *g = secretary_get(route, &error);
  if (!g) {
    fprintf(stderr, "get failed: %s\n", error);
    return 1;
  }
  char reply[256];
  snprintf(reply, sizeof reply, "ここは %s です", cJSON_GetStringValue(cJSON_GetObjectItem(g, "name")));
  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "reply", reply);
  cJSON_AddArrayToObject(out, "steps");
  secretary_output(out);
  return 0;
}
