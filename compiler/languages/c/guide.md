# C/C++ でモジュールを書く

wasi-sdk 25(clang)で wasm32-wasip1 のコマンドにします。`main.c`(C++ なら `main.cpp`)が入口です。ファイルは最上位かその下1階層に `.c` `.h` `.cc` `.cpp` `.hpp` を32個まで置けます。コンパイルの設定(フラグ・リンクするもの)は固定で、変えられません。

- C は C17、C++ は C++20。例外(`throw`)は使えません(`-fno-exceptions`)
- 使えるライブラリ: 標準ライブラリ、cJSON(`#include "cJSON.h"`)、SDK(`#include "secretary.h"`)
- 実行時は標準入出力・時計・乱数だけ。ファイル・ネットワークはありません。メモリは64MiBまで

## SDK

```c
cJSON *secretary_input(void);                               // 標準入力の JSON(guild, actor, eventName, event, batch, params, state)
cJSON *secretary_call(const cJSON *request, char **error);  // {"fn": ...} を送り value を返す。失敗は NULL と *error
cJSON *secretary_get(const char *route, char **error);      // Discord REST の GET(作成者が読める範囲)
void secretary_output(const cJSON *result);                 // 標準出力に { steps, state?, reply? }
```

## 例: コマンドに返事をする

```c
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
```
