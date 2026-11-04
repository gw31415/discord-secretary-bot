// The library entry build.sh compiles: importing main runs its top-level code
// when the module initializes (_start, see adapter.wat).
import "../src/main";

export function run(): void {}
