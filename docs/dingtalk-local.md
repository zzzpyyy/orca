# Set up the local DingTalk connector

The local connector runs inside Orca and uses the official `dws` command line ([dingtalk-workspace-cli](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)) on the bot's computer. It does not use Orca Cloud, MCP, or a webhook. dws keeps the DingTalk sign-in; Orca never reads it.

## Set it up

1. Install `dws` from the official releases and sign in once on the bot's computer with `dws auth login`.
2. In Orca, open the bot's **Connectors** page, choose **Add a connector → DingTalk**.
3. Pick the dws account, then add:
   - **Direct messages**: the people who may message the bot one to one. Only their 1:1 messages reach the bot; a DM from anyone else is dropped. Mark your own entry **This is me**, so your DingTalk turns count as the owner's and what you type in the bot's chat in Orca posts back to you, as Slack does.
   - **Groups**: each group answers either on an @mention that starts with the prefix (`/tsbot` by default) or on every message.
4. Choose whether answers post back to DingTalk (**Reply in DingTalk**) and whether a card shows progress while the bot works (**Show progress while it works**). Both settings hold for every bot using DingTalk on that computer.
5. Save. The connector applies the setup at once; no restart is needed.

The DingTalk row on the Connectors page shows the dws version and listeners, any reply that didn't post, and why live progress is off. Its **Conversations** list opens each DingTalk conversation's chat, including after its tab is closed. After the chat is deleted, the next message starts a new one.

## Replies

With progress on, each DingTalk-started turn gets a card at once. The card shows the bot's latest thinking, cut short, and each step as its tool name, a short summary and its state; it is edited at most once a second and ends as the answer. An answer longer than one card continues in further messages. When the card can't be sent or edited (for example, a missing permission), DingTalk gets a short notice and then the answer as messages, and the row names the reason.

## The setup file

The setup is stored in `dingtalk-local.json` in the Orca profile data directory (`DINGTALK_LOCAL_CONFIG` overrides the path). Edit it through the setup dialog; a file that fails validation is left unchanged and the save fails. `dwsPath` defaults to `dws` on `PATH`; set it to an absolute path when dws lives elsewhere. Paths are not expanded.

The connector keeps its delivery ledger in `dingtalk-local-ledger.json` beside it, written through a temporary file and rename. If an existing ledger can't be read or fails validation, the connector does not start and leaves the file for diagnosis; move it away to start empty. Replies use stable dws idempotency keys, so an answer is posted once across restarts; a send whose outcome dws couldn't confirm stays marked uncertain on the row instead of being sent twice.
