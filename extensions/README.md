# Desktop notifications (optional)

`notify-user.ts` provides `notify_user` for attention requests and task completion.
Desktop notifications are optional: without `terminal-notifier` on `PATH`, the
tool returns a skipped result without attempting delivery. The coding workflow
continues normally; no desktop notification dependency is required.

On macOS, install the optional client with `brew install terminal-notifier` and
allow notifications in System Settings. An installed client that fails to send
still reports an error; submission does not prove visible delivery.

Linux notification daemons such as dunst or mako are also optional. This tool
currently only uses `terminal-notifier`; it does not yet integrate `notify-send`
or Linux daemons. Linux/headless setups without that client skip notifications.

This tool calls the notifier directly, independently of agent coordinator.
