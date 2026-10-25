## The bot's side of the ABI: read the run's input, call the host, write the result.
## `import secretary` (std/json comes with it).
import std/json
export json

proc hostCall(req: pointer, reqLen: uint32, resp: pointer, respCap: uint32): int32
  {.importc: "secretary_host_call", header: "secretary_abi.h".}

proc readStdin(): string =
  result = ""
  var buf: array[65536, char]
  while true:
    let n = readBuffer(stdin, addr buf[0], buf.len)
    if n <= 0: break
    let start = result.len
    result.setLen(start + n)
    copyMem(addr result[start], addr buf[0], n)

proc input*(): JsonNode =
  ## The run's input: guild, actor, eventName, event, batch, params, state.
  parseJson(readStdin())

type HostError* = object of CatchableError

proc call*(request: JsonNode): JsonNode =
  ## Sends one request (such as %*{"fn": "get", "route": "/guilds/1"}) and returns its value.
  var req = $request
  var resp = newString(65536)
  while true:
    let n = hostCall(addr req[0], uint32(req.len), addr resp[0], uint32(resp.len))
    if n < 0:
      resp = newString(-n)
      continue
    resp.setLen(n)
    let res = parseJson(resp)
    if res.hasKey("error"): raise newException(HostError, res["error"].getStr)
    return res{"value"}

proc get*(route: string): JsonNode =
  ## GETs a Discord route the rule's owner may read.
  call(%*{"fn": "get", "route": route})

proc output*(result: JsonNode) =
  ## Writes the result: { steps, state?, reply? }.
  stdout.write($result)
  stdout.flushFile()

# Nim's own main takes (argc, argv, env), which wasi-libc does not call; this one starts the program.
{.emit: """
N_LIB_PRIVATE void NimMain(void);
int main(void) { NimMain(); return 0; }
""".}
