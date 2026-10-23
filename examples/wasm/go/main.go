// A /hello command in Go: replies with the server's name and who ran it.
// Build: GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"unsafe"
)

//go:wasmimport secretary call
func hostCall(reqPtr unsafe.Pointer, reqLen uint32, respPtr unsafe.Pointer, respCap uint32) int32

// call sends one request to the bot and decodes its answer's value into out.
func call(request any, out any) error {
	req, err := json.Marshal(request)
	if err != nil {
		return err
	}
	buf := make([]byte, 64*1024)
	for {
		n := hostCall(unsafe.Pointer(&req[0]), uint32(len(req)), unsafe.Pointer(&buf[0]), uint32(len(buf)))
		if n < 0 { // too small: the answer needs -n bytes
			buf = make([]byte, -n)
			continue
		}
		var res struct {
			Value json.RawMessage `json:"value"`
			Error string          `json:"error"`
		}
		if err := json.Unmarshal(buf[:n], &res); err != nil {
			return err
		}
		if res.Error != "" {
			return fmt.Errorf("%s", res.Error)
		}
		return json.Unmarshal(res.Value, out)
	}
}

type Input struct {
	Guild     string `json:"guild"`
	EventName string `json:"eventName"`
	Event     struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"event"`
}

func main() {
	raw, _ := io.ReadAll(os.Stdin)
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		fmt.Fprintln(os.Stderr, "bad input:", err)
		os.Exit(1)
	}
	var guild struct {
		Name string `json:"name"`
	}
	if err := call(map[string]any{"fn": "get", "route": "/guilds/" + in.Guild}, &guild); err != nil {
		fmt.Fprintln(os.Stderr, "get failed:", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "guild:", guild.Name)
	out, _ := json.Marshal(map[string]any{
		"reply": fmt.Sprintf("<@%s> さん、ここは %s です(Goより)", in.Event.User.ID, guild.Name),
		"steps": []any{},
	})
	os.Stdout.Write(out)
}
