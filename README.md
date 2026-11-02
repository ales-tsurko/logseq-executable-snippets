# Executable Snippets

Run Logseq DB code blocks with configurable commands, live output, input prompts,
and a Stop button. Uses Logseq's native editor and theme.

## Build and install

Requires macOS or Linux, Node.js 22+, npm, Logseq DB, and your chosen script runtimes.

```sh
npm ci
npm run build
npm run setup
```

In Logseq developer mode, **Plugins → Load unpacked plugin** and select this
directory. Run `npm run setup` after restarting your computer to start the local
helper. `npm run helper:stop` stops it and its processes.

## Use

Choose a code language and click **Run**. Templates such as `python3 -u -c $`
receive the snippet as one `$` argument. Nothing runs automatically.

Edit commands through **Executable Snippets: Settings** in the command palette.
**Configure** overrides a block's command or directory. **directory**
also inherits from parent blocks and pages.

Use **Send** for prompts, **End input** for EOF, and **Stop** to terminate the
process group. This uses input/output pipes, not a terminal emulator.
Output stays in memory, limited to 200,000 characters.

Uses Logseq's experimental host-access API. [AGPL-3.0-or-later](LICENSE.md).
