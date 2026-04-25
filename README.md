# arXiv Daily

每天自动从 arXiv 抓取 5 个方向（世界模型 / RL / 蒸馏 / 视频生成 / 4D 生成）的新论文，
用 Google Gemini 生成中文摘要，托管在 GitHub Pages。

## 项目结构

```
.
├── scripts/
│   ├── config.py       # 主题关键词 + arxiv 分类配置
│   ├── fetch.py        # 调 arXiv API 抓最近 N 天的论文
│   ├── classify.py     # 关键词把论文打到 5 个主题上
│   ├── summarize.py    # 调 Gemini 生成中文摘要
│   └── main.py         # 整条流水线
├── data/               # 每日 JSON 数据（YYYY-MM-DD.json + index.json）
├── .github/workflows/daily.yml   # 每天 UTC 01:30 自动跑
├── index.html / app.js / style.css   # 前端
└── README.md
```

## 部署到 GitHub Pages（首次设置）

### 1. 创建仓库并推送代码

```bash
cd C:\Users\lijia\Desktop\arxiv-daily
git init -b main
git add .
git commit -m "init"
# 在 github.com 上新建一个空仓库（不要勾 README），然后：
git remote add origin https://github.com/<你的用户名>/arxiv-daily.git
git push -u origin main
```

### 2. 配置 LLM API key 到仓库 Secrets

支持两套 key（主用 + fallback），任意一套缺失也能跑（缺则跳过）。

主 key：可以是 Google AI Studio 直发的 Gemini key，也可以是兼容 Gemini 接口
（如 `viviai.cc`）的中转代理 key。

#### 在仓库设置里加 secrets / variables

仓库 → **Settings** → **Secrets and variables** → **Actions**

| 类型 | 名字 | 值 |
|---|---|---|
| Secret | `GEMINI_API_KEY` | 主 key（如 viviai 的 sk-... 或 Google 的 AIza...） |
| Variable | `GEMINI_BASE_URL` | 主 key 对应的 base URL（如 `https://api.viviai.cc/v1beta`）<br>用 Google 直发就**不用建这个**，默认就是官方地址 |
| Secret | `GEMINI_API_KEY_FALLBACK` | （可选）备用 key，主 key 配额用完后自动切到这个 |
| Variable | `GEMINI_FALLBACK_BASE_URL` | （可选）备用 key 的 base URL，留空就是 Google 官方 |

#### 申请 Google 官方 Gemini key（推荐当 fallback）

1. 访问 https://aistudio.google.com/apikey （需要 Google 账号，国内访问需要科学上网）
2. **Create API key** → 选项目 → 复制
3. 加到 `GEMINI_API_KEY_FALLBACK`

免费档（gemini-2.5-flash）每分钟 10 次、每天 250 次，本项目刚好够用。

### 3. 开启 GitHub Pages

仓库 → **Settings** → **Pages** → **Source** 选 **GitHub Actions**

### 4. 手动触发第一次运行

仓库 → **Actions** → 左侧 **Daily arXiv update** → 右上 **Run workflow** → **Run**

跑完后访问 `https://<你的用户名>.github.io/arxiv-daily/` 就能看到内容。
之后每天 UTC 01:30（北京 09:30）自动更新。

## 本地运行（可选，用来验证）

```bash
cd scripts
pip install --upgrade pip   # 只用了标准库，不用装额外依赖
# 不带 key 也能跑，只是没有中文摘要
python main.py
# 用真实 key（PowerShell）：
$env:GEMINI_API_KEY="你的key"; python main.py
```

然后在项目根目录起一个 HTTP 服务看效果：

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

## 调整关注方向

编辑 `scripts/config.py` 里的 `TOPICS`：增删主题、改关键词都可以。
注意关键词用整词匹配（`\b...\b`），多词短语（如 `world model`）会按整短语匹配。

## 跨设备同步「我的」

「我的」里的收藏、备注、子分类、排序默认只存在你**当前浏览器** 的 localStorage。
要在多台设备/多个浏览器之间同步，用 GitHub Gist：

1. 打开网站，右上角点 **☁ 同步**
2. 模态框里有一个链接，点开 → 在 GitHub 上生成 Personal Access Token
   - 已为你勾好 `gist` 权限（这是 token 唯一拥有的权限）
   - 过期时间随你选；点 **Generate token**
3. 复制以 `ghp_` 开头的字符串 → 粘到模态框 → 点「连接」
4. 第一次连接会自动建一个 **secret gist** 存放数据
5. 在另一台设备上访问网站、打开模态框、粘**同一个 token** → 自动拉数据

要撤销/换 token：GitHub 头像 → Settings → Developer settings → Personal access tokens → Revoke。
撤销后该设备上的「我的」会停止上传，但本地数据还在。

## 成本估算

`gemini-2.5-flash` 免费档：每分钟 10 RPM、每天 250 RPD、每分钟 250K TPM。
本项目每天 ~30 篇论文，远低于免费额度上限。
若超出免费档（一般不会），按官方付费档计费极便宜。
