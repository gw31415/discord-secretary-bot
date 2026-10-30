// Package secretary is the bot's side of the ABI: read the run's input, call
// the host, write the result. Import it as "bot/secretary".
package secretary

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"unsafe"
)

//go:wasmimport secretary call
func hostCall(reqPtr unsafe.Pointer, reqLen uint32, respPtr unsafe.Pointer, respCap uint32) int32

// Input decodes the run's input ({ guild, actor, eventName, event, batch, params, state }) into v.
func Input(v any) error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

// Call sends one request (such as {"fn": "get", "route": "/guilds/1"}) and decodes its value into out.
func Call(request any, out any) error {
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
			return errors.New(res.Error)
		}
		if out == nil || len(res.Value) == 0 {
			return nil
		}
		return json.Unmarshal(res.Value, out)
	}
}

// Get reads a Discord route the rule's owner may read.
func Get(route string, out any) error {
	return Call(map[string]any{"fn": "get", "route": route}, out)
}

// GetQuery is Get with a query string, e.g. GetQuery("/channels/1/messages", map[string]any{"limit": 1}, &msgs).
func GetQuery(route string, query map[string]any, out any) error {
	return Call(map[string]any{"fn": "get", "route": route, "query": query}, out)
}

// Output writes the result: { steps, state?, reply? }.
func Output(result any) error {
	b, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(b)
	return err
}
