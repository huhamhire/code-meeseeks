# 评论互动（Comment Interactions）

PR 评论之上的三类人工互动：**emoji 反应**、**@提及自动补全**、**图片附件上传**。三者都建立在既有评论
读写闭环（见 [`05-review-workflow`](05-review-workflow.md)）与平台适配层（见 [`01-platform-adapter`](01-platform-adapter.md)）之上，按平台能力位显隐降级。

## 1. 职责与边界

- **负责**：评论的「互动增强」——给已有评论加 / 取 emoji 反应并展示聚合；撰写评论 / 回复时 `@提及`
  用户的就地补全；撰写时粘贴图片上传并回填正文。
- **不负责**：评论本体的增删改查与回复（属评审闭环 05）、行内评论锚定（属 diff）、评论正文的 markdown
  渲染与内嵌图片代理拉取（既有能力，本域仅在上传后复用其渲染）。
- **边界原则**：互动是**纯增益**——任一项不被平台支持、或其数据获取失败，都不得影响评论列表的正常加载与
  展示（best-effort，失败静默降级）。

## 2. 核心设计

### 能力位驱动的显隐降级

三项各由能力位声明（`commentReactions` / `commentAttachments`，以及 @提及无需后端能力），渲染层据此
显 / 隐入口。平台不支持即整块不出现，不在调用处写 `if (platform === …)`（沿用 01 的降级范式）。其中
`commentReactions` 取三态 `false | 'fixed' | 'free'`——`fixed` 仅固定集（GitHub 8 种、无搜索），`free`
支持任意 emoji（精选集 + 搜索）。

| 能力 | GitHub | Bitbucket | GitLab |
| --- | --- | --- | --- |
| 反应 `commentReactions` | `'fixed'`（8 种） | `'free'`（7.x+） | `'free'` |
| 附件 `commentAttachments` | ✗（无公开上传 API） | ✓ | ✓ |
| @提及补全 | ✓（无需能力位） | ✓ | ✓ |

### emoji 反应：统一 emoji 字符为中性 key

各平台原生反应标识互不相同——GitHub 是固定 8 种 content（`+1`/`laugh`…）、GitLab 是 award emoji 名
（`thumbsup`…）、Bitbucket 是 emoticon shortcut（`eyes`…）。中性模型 `PrReaction` 以 **Unicode emoji
字符**为 key（`{ emoji, count, mine }`），渲染层直接绘制、跨平台一致；**原生名 ↔ emoji 的映射由各
平台 adapter 私有持有**（它最了解自家 API）。

选择器按模式取候选：`fixed`（GitHub）用 `REACTION_PICKER`（固定 8 种，无搜索，对齐 GitHub Reactions
API 上限）；`free`（GitLab / Bitbucket）用**内置精选大集** `REACTION_EMOJIS`（~150 个高频 emoji + 标准
shortcode + 检索关键词）+ 搜索框。GitLab award 名 / Bitbucket emoticon shortname 同为标准 emoji
shortcode，故 free 两端的 char↔原生名映射（`emojiToReactionCode` / `reactionCodeToEmoji`）统一从该集
派生。用户经 web 用集外 emoji 反应的，仍按字符**显示**（best-effort：Bitbucket 从 twemoji url 码点解、
GitLab 按 award 名回查），仅 picker 不提供。**后向扩展点**：要加一种反应，在 `REACTION_EMOJIS` 追加一行
（emoji + 正确 shortcode + 关键词）即可，free 两端 adapter 自动生效；fixed 集另在 `REACTION_PICKER` +
GitHub content 映射维护。

刻意用**内置精选集**而非全量 Unicode / 第三方大词表，原因有二：

- 避免打包冗余与「比实例 Twemoji 版本新的 emoji 写入静默失败」（如 Bitbucket 实测自带 Twemoji 12.1.2、~1180 个，全量词表是其超集）；
- 精选集 shortcode 可控、写入可靠。

代价是长尾 emoji 搜不到——经评估对评审场景足够（含 alien 等常用项）。

选择器为避免被评论滚动容器裁切 / 与其它层级 z-index 干涉，经 **portal 渲染到 body + fixed 定位**，坐标
由触发按钮位置 + 视口空间算出（上下自适应翻转、水平夹取），并随滚动 / 缩放重算；点击弹层外部 / Esc 收起。
「加反应」按钮置于评论操作按钮行内，已有反应另起一行展示在其下。

**读取的有界化**：反应聚合的获取按平台差异处理，且一律 best-effort（单条失败不拖垮列表）——

- GitHub：评论响应自带反应计数（counts），无需额外请求即可展示；仅「当前用户是否反应过」（`mine`）
  需补查，且**只对有反应的评论**（counts>0）发请求，额外请求数受真实反应数约束。
- GitLab：note 不内嵌 award，须逐 note 查 award_emoji（并行）；单条失败 catch 成无反应。
- Bitbucket：反应随评论 `properties.reactions` 一并返回，**零额外请求**。

**切换语义**：`toggleReaction(add)` 幂等——add 时重复加按成功处理；remove 时 GitHub/GitLab 需先查到
自己那条反应的 id 再删，不存在则跳过。成功后走既有「写后清缓存 + 广播 `comments:changed` + 重拉」模型，
不维护前端乐观态（与编辑 / 删除一致）。

### @提及：参与者候选 + 客户端补全

通知由平台服务端对评论正文里的 `@name` 自动完成，故**后端零改动**即已生效；本域只做撰写时的补全 UX。

候选源刻意只取**本 PR 已加载的参与者**——评论作者（含 replies 递归）+ 提交作者——按 name 去重。这是
**有界、零额外取数、安全**的来源：不向远端枚举全员（大组织几千人，既慢又触发限流，也避免越权拉取），
候选规模约等于参与者数（通常 < 20）。输入 `@` 后按查询串客户端过滤、展示前若干条；补全仅为便利，用户
仍可自由手打任意 `@name`（平台据文本自行解析通知）。需要更广检索时，可在此基础上叠加「平台用户搜索
端点」层（带 query 过滤 + 分页截断），但默认不开。

### 图片附件：平台原生上传 + 既有渲染复用

粘贴图片 → 渲染层拦截 → 经 IPC 把字节交 adapter 上传 → 回填平台返回的 markdown 到正文。各平台：

- **GitLab**：上传到项目级 `/uploads`，返回 `![file](/uploads/<secret>/<file>)`；该相对 URL 经既有
  附件代理（走带 PAT 的 API 下载端点）渲染，无额外渲染改动。
- **Bitbucket**：上传到仓库级 attachments 端点（multipart 字段 `files`，须带 `X-Atlassian-Token:
  no-check` 绕 XSRF），用响应的 `attachment:<repoId>/<id>` 形式 markdown；既有渲染已识别 `attachment:`
  协议。
- **GitHub**：无公开附件上传 API（web 端走未文档化私有端点），能力位为假 → 渲染层不挂粘贴上传入口。

上传期间禁用输入框，避免异步回填时正文已被改动导致插入位置漂移。

## 3. 数据 / 接口契约

- **`PrReaction`**：`{ emoji: string; count: number; mine: boolean }`，挂在 `PrComment.reactions?`。
- **`REACTION_PICKER`**：共享常量，`fixed` 模式候选 emoji 字符（固定 8 种）。
- **`REACTION_EMOJIS`**：共享精选集 `{ emoji, code, keywords }[]`，`free` 模式候选 + 搜索源 + char↔code 映射来源。
- **能力位**：`commentReactions: false | 'fixed' | 'free'`；`commentAttachments`（布尔）。
- **`CommentService.toggleReaction(repo, prId, commentId, kind, emoji, add)`**：切换反应；`kind`
  （summary / inline）供 GitHub 选 issue / review 反应端点，其余平台忽略；不支持的平台默认抛错。
- **`MediaService.uploadAttachment(repo, prId, file)`**：`file` 为 `CommentAttachmentUpload`
  （`{ fileName, contentType, bytes }`），返回 `CommentAttachmentResult`（`{ markdown }`）或 null
  （不支持）。
- **IPC 通道**：`comments:toggleReaction`（成功后广播 `comments:changed`）；`comments:uploadAttachment`
  （字节走 `ArrayBuffer` 传输，main 端转 `Uint8Array` 交 adapter；仅产出 markdown、不动评论缓存）。
- **i18n**：反应入口走 `reactions.*`，上传状态走 `attachments.*`。

## 4. 扩展与注意事项

- **新增平台**：实现 `toggleReaction` / `uploadAttachment`、声明对应能力位、提供本平台「原生名 ↔ emoji」
  映射即可；不支持的项保持默认（反应抛错 / 上传返回 null），能力位置假即整块隐藏。
- **Bitbucket 反应形状已实测核定**：`properties.reactions[].emoticon` 给 `shortcut` + `url`（twemoji
  SVG，文件名即 Unicode 码点，如 `1f440.svg`），无 `value`、无 `count` 字段（计数取 `users.length`）。
  展示 emoji **优先从 url 码点解码**（对任意 emoji 都成立），回退 shortcut 名映射。emoticon shortcut
  命名不规范（如 `smile` / `laughing`），写入（toggle）用 `REACTION_EMOJIS` 建的 char→shortcode 表，
  新增反应种类时在该精选集补行并确保 shortcode 为真实实例接受。
- **读取一律 best-effort**：反应 / award 的补查失败必须 catch 成「无反应」，绝不冒泡中断评论列表加载。
- **@提及不扩成全员枚举**：候选默认限本 PR 参与者；若引入平台用户搜索，须带 query 过滤 + 结果截断 +
  防抖 + 取消在途，避免拉全量与限流（见对取数安全的约束）。
- **附件渲染依赖既有代理**：上传只负责产出 markdown，内嵌图片的鉴权拉取与展示复用既有评论图片代理；
  新平台若采用新的 URL 形态，需同步让附件代理识别。
