# DSH 客户端插槽目录（从已安装的 DSH app.asar 提取）

本文件是 Prompt Lab 开发时用来选挂载点的离线参考：从本机
`D:\app\tool\DeepSeek Harness\resources\app.asar` 内嵌的插槽账本（slot ledger）中提取，
每条记录都带有声明它的源码路径（账本里的 `source` 字段）。

- **single**：单占用插槽。注册即替换已占用者，宿主自带的 UI 会消失，慎用。
- **list**：列表插槽。带自己的 `id` 注册即追加，`order` 决定先后。
- **keyed**：按 key 分发，需要 `entryKey` 命中宿主给出的键（如工具名、tab 类型）。
- **chain**：链式插槽，靠纯函数 `select(owner)` 判断是否接管。

用法：`ctx.slots.inject("<key>", () => ctx.slots.register({ name: "<key>", id: "<自己的 id>" }, () => h(View)))`。

`ctx.slots.inject` 会等待该 slot 被声明：声明不存在时挂起，声明塌缩时自动撤回贡献，恢复后重新注册，
所以插件不需要自己判断宿主当前有没有这个席位。

Prompt Lab 只占一个席位：`conversation.view`（id `prompt-lab`，order 20，与「对话」（order 0）、
「轨迹」（order 10）并排的会话页签；选中时宿主在会话视图区就地渲染面板）。页签条只在注册了 ≥2 个 View 时才会出现。

| 插槽 key | 类型 | 现有占用 | 说明 | 声明位置 |
| --- | --- | --- | --- | --- |
| `conversation.approval.detail` | 单选（会顶掉原占用者） | 1 | Optional detail for the Tool call correlated with an approval request. | `packages/client/ui-approval/src/client/contract/slots.ts:37` |
| `conversation.chat.assistant-actions` | 列表（追加） | 1 | Ordered actions for one finalized assistant message. | `packages/client/ui-chat/src/client/contract/slots.ts:321` |
| `conversation.chat.commandview` | 键控（按 key 分发） | 0 | Command row keyed by the command name. | `packages/client/ui-chat/src/client/contract/slots.ts:309` |
| `conversation.chat.node` | 键控（按 key 分发） | 19 | Final Chat node renderer, keyed by `ChatNodeKind`. | `packages/client/ui-chat/src/client/contract/slots.ts:290` |
| `conversation.chat.turnTail` | 列表（追加） | 3 | Ordered feature contributions before a completed Turn's action row. | `packages/client/ui-chat/src/client/contract/slots.ts:315` |
| `conversation.composer` | 链（选择器接管） | 3 | Selector-routed replacements for the current Session's resident composer. | `packages/client/ui-conversation/src/client/contract/slots.ts:187` |
| `conversation.composer.bar` | 单选（会顶掉原占用者） | 1 | Resident composer body, including the no-Session inert state. | `packages/client/ui-conversation/src/client/contract/slots.ts:207` |
| `conversation.composer.dock` | 列表（追加） | 1 | Ambient entries below the composer card. | `packages/client/ui-conversation/src/client/contract/slots.ts:199` |
| `conversation.header` | 单选（会顶掉原占用者） | 1 | Resident navigation container, including when no Session is selected. | `packages/client/ui-conversation/src/client/contract/slots.ts:139` |
| `conversation.header.leading` | 单选（会顶掉原占用者） | 0 | Global navigation before the Session title, available without a Session. | `packages/client/ui-conversation/src/client/contract/slots.ts:168` |
| `conversation.hero.agentPreset` | 单选（会顶掉原占用者） | 1 | Agent-preset control staged for a New Session. | `packages/client/ui-conversation/src/client/contract/slots.ts:193` |
| `conversation.hero.brand.mark` | 单选（会顶掉原占用者） | 0 | Brand mark shown before the blank-session headline. | `packages/client/ui-conversation/src/client/contract/slots.ts:191` |
| `conversation.hero.workspace` | 单选（会顶掉原占用者） | 1 | Workspace picker shown by the blank-session Hero. | `packages/client/ui-conversation/src/client/contract/slots.ts:189` |
| `conversation.hero.workspace.directoryFlow` | 单选（会顶掉原占用者） | 2 | Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). | `packages/client/ui-workspace/src/client/contract/slots.ts:117` |
| `conversation.input.activity` | 单选（会顶掉原占用者） | 1 | Compact action after the model selector; it can expand across the toolbar while retaining the editor and submit action. | `packages/client/ui-conversation/src/client/contract/slots.ts:205` |
| `conversation.input.attachments` | 单选（会顶掉原占用者） | 1 | Optional draft-attachment rail and drop target. | `packages/client/ui-conversation/src/client/contract/slots.ts:209` |
| `conversation.input.dock` | 列表（追加） | 3 | Full-width entries above the composer card. | `packages/client/ui-conversation/src/client/contract/slots.ts:195` |
| `conversation.input.left` | 列表（追加） | 0 | Compact controls at the left of the composer tool row. | `packages/client/ui-conversation/src/client/contract/slots.ts:201` |
| `conversation.input.model` | 单选（会顶掉原占用者） | 1 | Model selector inside the composer tool row. | `packages/client/ui-conversation/src/client/contract/slots.ts:223` |
| `conversation.input.overlay` | 列表（追加） | 3 | Floating entries rendered inside the resident composer card. | `packages/client/ui-conversation/src/client/contract/slots.ts:197` |
| `conversation.input.permission` | 单选（会顶掉原占用者） | 1 | Current-session permission control inside the composer tool row. | `packages/client/ui-conversation/src/client/contract/slots.ts:217` |
| `conversation.input.plan` | 单选（会顶掉原占用者） | 1 | Plan control inside the composer tool row. | `packages/client/ui-conversation/src/client/contract/slots.ts:215` |
| `conversation.input.right` | 列表（追加） | 0 | Compact controls before the composer submit action. | `packages/client/ui-conversation/src/client/contract/slots.ts:203` |
| `conversation.message.images` | 单选（会顶掉原占用者） | 1 | Renderer for one consecutive group of durable message images. | `packages/client/ui-chat/src/client/contract/slots.ts:303` |
| `conversation.plan-review.actions` | 列表（追加） | 1 | Actions for the exact plan under review; approval remains with the question composer. | `packages/client/ui-user-questions/src/client/contract/slots.ts:21` |
| `conversation.session` | 单选（会顶掉原占用者） | 1 | Strict per-Session Conversation body. | `packages/client/ui-conversation/src/client/contract/slots.ts:133` |
| `conversation.session.header` | 单选（会顶掉原占用者） | 1 | Strict per-Session title, actions, and View navigation. | `packages/client/ui-conversation/src/client/contract/slots.ts:141` |
| `conversation.session.header.actions` | 列表（追加） | 4 | Title-adjacent Session actions in ascending order. | `packages/client/ui-conversation/src/client/contract/slots.ts:156` |
| `conversation.session.header.corner` | 单选（会顶掉原占用者） | 1 | The header's far-right corner, past the utilities' edge and into the header's own padding, for one control. | `packages/client/ui-conversation/src/client/contract/slots.ts:179` |
| `conversation.session.header.lineage` | 单选（会顶掉原占用者） | 1 | Optional replacement for one Session breadcrumb title. | `packages/client/ui-conversation/src/client/contract/slots.ts:150` |
| `conversation.session.header.utilities` | 列表（追加） | 3 | Right-aligned Session utilities in ascending order. | `packages/client/ui-conversation/src/client/contract/slots.ts:162` |
| `conversation.trajectory.images` | 单选（会顶掉原占用者） | 1 | Renderer for one group of durable record images in the Trajectory ledger. | `packages/client/ui-trajectory/src/client/trajectory-contract.ts:98` |
| `conversation.view` | 列表（追加） | 2 | Registered Conversation target Views, rendered one at a time. | `packages/client/ui-conversation/src/client/contract/slots.ts:185` |
| `deliverables.file.actions` | 列表（追加） | 1 | Open one file through its authorized Session event coordinates. | `packages/client/ui-deliverables/src/client/file-actions.ts:8` |
| `deliverables.review.file.actions` | 列表（追加） | 1 | The same file actions owned by a changed-file review tab. | `packages/client/ui-deliverables/src/client/file-actions.ts:21` |
| `main.conversation` | 单选（会顶掉原占用者） | 1 | Conversation shell beneath its root-scoped main-panel entry. | `packages/client/ui-conversation/src/client/contract/slots.ts:131` |
| `plugins.bundle.activation` | 键控（按 key 分发） | 1 | Optional guidance after the user enables a bundle from the list, keyed by npm package name. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:78` |
| `plugins.bundle.config` | 键控（按 key 分发） | 1 | A bundle's own configuration, keyed by the bundle's package name and rendered on the bundle's page between its description and its rows (`view: 'page'` only). | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:94` |
| `plugins.detail.actions` | 列表（追加） | 0 | Controls at the head of a detail page, before the page's own switch and uninstall, rendered with the page's subject. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:108` |
| `plugins.detail.badge` | 列表（追加） | 0 | Tags beside a detail page's title, after the version, beta, and problem tags the page draws itself, rendered with the page's subject. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:113` |
| `plugins.detail.section` | 列表（追加） | 0 | Sections under a detail page's own content: after the rows on a bundle's page, after the configuration on a row's or an official plugin's page. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:120` |
| `plugins.item` | 列表（追加） | 4 | One official plugin the Plugins page lists in its Official group after the official bundles: `label` is the card's title and `order` its place. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:88` |
| `plugins.row.config` | 键控（按 key 分发） | 0 | The configuration of one row a bundle declares, keyed by `<package name>#<row id>` with the row id as the bundle's patch declares it: the row on the bundle's page gains a configure control that opens the entry's page, headed by the plugin's display title and description. | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:102` |
| `rightbar.session` | 单选（会顶掉原占用者） | 1 | Session content selected by the root-scoped right Sidebar controller. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:43` |
| `settings.action` | 列表（追加） | 1 | Optional actions rendered in the content-column header before Close. | `packages/client/ui-settings/src/client/contract/slots.ts:39` |
| `settings.close` | 单选（会顶掉原占用者） | 1 | The close button's visually-hidden label text (the button itself â icon, geometry, focus â is shell chrome). | `packages/client/ui-settings/src/client/contract/slots.ts:45` |
| `settings.general.item` | 列表（追加） | 12 | One preference row inside the General section â the additive seat for a single setting that needs no page of its own (a whole page is `settings.section`), contributed by the feature plugin that owns the preference (locale â Language, ui-theme â Appearance, ui-conversation â Composer Enter). | `packages/client/ui-settings/src/client/contract/slots.ts:92` |
| `settings.header` | 单选（会顶掉原占用者） | 1 | The panel title text seat. | `packages/client/ui-settings/src/client/contract/slots.ts:33` |
| `settings.launcher` | 单选（会顶掉原占用者） | 1 | Optional sidebar account launcher; opens the shell-owned settings panel. | `packages/client/ui-settings/src/client/contract/slots.ts:17` |
| `settings.models.footer` | 列表（追加） | 0 | Ordered extension area after the provider rows and the add controls. | `packages/client/ui-settings-models/src/client/slot-contract.ts:40` |
| `settings.models.provider-card` | 键控（按 key 分发） | 0 | One provider card's adapter extension area, dispatched with `entryKey = settingsNs` on every card that renders a directory row: a saved row's card (its first-run setup posture included) and the add-provider draft card. | `packages/client/ui-settings-models/src/client/slot-contract.ts:33` |
| `settings.models.sign-in` | 单选（会顶掉原占用者） | 1 | Optional account login choice before the credential editor. | `packages/client/ui-settings-models/src/client/slot-contract.ts:35` |
| `settings.onboarding` | 列表（追加） | 2 | Root-scoped onboarding steps contributed by settings features. | `packages/client/ui-settings/src/client/contract/slots.ts:77` |
| `settings.plugins.tab` | 列表（追加） | 1 | One page inside the Plugins settings section. | `packages/client/ui-settings/src/client/contract/slots.ts:66` |
| `settings.section` | 列表（追加） | 5 | One settings page per list entry. | `packages/client/ui-settings/src/client/contract/slots.ts:57` |
| `settings.trigger` | 单选（会顶掉原占用者） | 1 | The sidebar-foot trigger row content: icon + label, supplied as slot content (the accessible name comes from the content â rail state renders the label visually hidden). | `packages/client/ui-settings/src/client/contract/slots.ts:27` |
| `shell.leading` | 单选（会顶掉原占用者） | 1 | Window-chrome seat at the frame's top-left, over every main panel. | `packages/client/ui-layout/src/client/index.ts:112` |
| `shell.overlay` | 列表（追加） | 10 | Frame-wide floating layer, above every column and outside their scroll containers. | `packages/client/ui-layout/src/client/index.ts:98` |
| `shell.quota-notice` | 链（选择器接管） | 1 | Frame-wide quota notice chain. | `packages/client/ui-chat/src/client/contract/slots.ts:329` |
| `sidebar.brand.mark` | 单选（会顶掉原占用者） | 1 | Brand mark rendered in the expanded brand row and collapsed rail. | `packages/client/ui-sidebar/src/client/contract/slots.ts:25` |
| `sidebar.brand.name` | 单选（会顶掉原占用者） | 1 | Brand name rendered beside the expanded mark. | `packages/client/ui-sidebar/src/client/contract/slots.ts:30` |
| `sidebar.chat.conversation` | 单选（会顶掉原占用者） | 1 | Session-scoped Conversation occurrence hosted by one Sidebar chat tab. | `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:42` |
| `sidebar.footer.action` | 列表（追加） | 1 | Optional actions beside Settings at the sidebar foot. | `packages/client/ui-sidebar/src/client/contract/slots.ts:53` |
| `sidebar.panellist` | 列表（追加） | 2 | Global panel icons. | `packages/client/ui-sidebar/src/client/contract/slots.ts:35` |
| `sidebar.right.pane.tab` | 键控（按 key 分发） | 9 | One tab's body, dispatched with the `id` of the type in force for `tab.kind`. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:59` |
| `sidebar.right.pane.tab.title` | 键控（按 key 分发） | 7 | A tab's title as its chip (and a floating panel's header) shows it, dispatched with the same key and information hook as the body. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:73` |
| `sidebar.right.tab.document` | 键控（按 key 分发） | 8 | Document body selected by a registered implementation id. | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:51` |
| `sidebar.right.tab.document.action` | 键控（按 key 分发） | 1 | Renderer-specific controls before the document toolbar's reload button. | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:87` |
| `sidebar.right.tab.document.actions` | 列表（追加） | 1 | Header toolbar contributions acting on the previewed file, rendered after the preview's own controls once the file's Host path is known. | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:66` |
| `sidebar.right.tab.document.office.pdf` | 键控（按 key 分发） | 1 | PDF presentation supplied with Office-owned converted bytes. | `packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx:19` |
| `sidebar.right.tab.document.unpreviewable` | 列表（追加） | 1 | Empty-state contributions for a file this preview cannot render, offered where Retry would stand once the file's Host path is known. | `packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts:78` |
| `sidebar.right.tab.files.actions` | 列表（追加） | 1 | Workspace directory actions after the file tree's reload control. | `packages/client/ui-sidebar-files/src/client/index.ts:34` |
| `sidebar.right.tab.guide` | 链（选择器接管） | 0 | The guide tab's body. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:84` |
| `sidebar.right.tab.guide.entry` | 键控（按 key 分发） | 1 | One provider's guide card, with the standard card as the owner's fallback. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:91` |
| `sidebar.right.tab.menu.item` | 列表（追加） | 0 | Extra items at the end of one tab's actions menu, in registration order. | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:103` |
| `sidebar.session.row.hover` | 列表（追加） | 1 | Section of the Session row's hover card between its relative time and its trailing status line. | `packages/client/ui-workspace/src/client/contract/slots.ts:134` |
| `sidebar.session.row.leading` | 列表（追加） | 1 | Leading decoration of one Session row, in the 16px cell before the title that the row's own state dot otherwise occupies. | `packages/client/ui-workspace/src/client/contract/slots.ts:129` |
| `sidebar.settings` | 单选（会顶掉原占用者） | 1 | The settings seat at the sidebar foot. | `packages/client/ui-sidebar/src/client/contract/slots.ts:48` |
| `sidebar.toggle.badge` | 单选（会顶掉原占用者） | 1 | Non-interactive notification inside the collapsed sidebar expand button. | `packages/client/ui-sidebar/src/client/contract/slots.ts:19` |
| `sidebar.workspaces` | 单选（会顶掉原占用者） | 1 | The workspace/session browsing region: section header, search, the grouped/flat session list, and every workspace dialog. | `packages/client/ui-sidebar/src/client/contract/slots.ts:42` |
| `sidebar.workspaces.directoryFlow` | 单选（会顶掉原占用者） | 2 | Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). | `packages/client/ui-workspace/src/client/contract/slots.ts:119` |
| `sidebar.workspaces.session.menu.item` | 列表（追加） | 4 | The rows of one Session's \"...\" menu, in ascending `order`. | `packages/client/ui-workspace/src/client/contract/slots.ts:166` |
| `sidebar.workspaces.session.row.action` | 列表（追加） | 2 | The hover buttons at the end of one Session row, in ascending `order`, after the \"...\" menu trigger. | `packages/client/ui-workspace/src/client/contract/slots.ts:184` |
| `tool.call.images` | 单选（会顶掉原占用者） | 1 | Durable images of a settled image-bearing Tool call, rendered through the attachment presentation plugin. | `packages/client/ui-tool/src/client/contract/slots.ts:46` |
| `tool.call.toolview` | 键控（按 key 分发） | 54 | Keyed Tool call view dispatched by wire Tool name. | `packages/client/ui-tool/src/client/contract/slots.ts:26` |
| `tool.view.cordis` | 键控（按 key 分发） | 0 | Interactive Package-owned region rendered inside the latest eligible `cordis_run` card in the conversation flow. | `packages/extensions/ui-cordis/src/client/slots.ts:31` |
