package main

import (
	"fmt"
	"os"

	"bot/secretary"
)

func main() {
	var in struct {
		Guild string `json:"guild"`
	}
	if err := secretary.Input(&in); err != nil {
		fmt.Fprintln(os.Stderr, "bad input:", err)
		os.Exit(1)
	}
	var guild struct {
		Name string `json:"name"`
	}
	if err := secretary.Get("/guilds/"+in.Guild, &guild); err != nil {
		fmt.Fprintln(os.Stderr, "get failed:", err)
		os.Exit(1)
	}
	secretary.Output(map[string]any{"reply": "ここは " + guild.Name + " です", "steps": []any{}})
}
