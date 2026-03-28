# 飞书 API 参考

## 鉴权

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
Body: { "app_id": "cli_xxx", "app_secret": "xxx" }
Response: { "code": 0, "tenant_access_token": "t-xxx", "expire": 7200 }
```

后续请求 Header：`Authorization: Bearer <tenant_access_token>`

---

## 文档操作

### 创建文档
```
POST /docx/v1/documents
Body: { "title": "文档标题" }
Response: { "data": { "document": { "document_id": "xxx" } } }
```

### 查询文档块
```
GET /docx/v1/documents/{docId}/blocks?page_size=200
```

### 插入内容块（追加到文档末尾）
```
POST /docx/v1/documents/{docId}/blocks/{docId}/children
Body: { "children": [ <block> ], "index": -1 }
```

**注意**：新建文档第一次插入需要 `"index": 0`，之后都用 `-1`

### 删除文档块（批量清空）
```
DELETE /docx/v1/documents/{docId}/blocks/{docId}/children/batch_delete
Body: { "start_index": 0, "end_index": N }
```

---

## Block 类型对照表

| block_type | 含义   | 内容字段 key |
|-----------|--------|------------|
| 1         | page   | （根块，不可写入） |
| 2         | 段落 P | `text`      |
| 3         | H1     | `heading1`  |
| 4         | H2     | `heading2`  |
| 5         | H3     | `heading3`  |
| 22        | 分割线  | `divider: {}` |
| 27        | 图片   | `image: {}`  |

### 段落 Block 示例
```json
{
  "block_type": 2,
  "text": {
    "elements": [
      { "text_run": { "content": "普通文字" } },
      { "text_run": { "content": "粗体", "text_element_style": { "bold": true } } }
    ]
  }
}
```

### 标题 Block 示例
```json
{
  "block_type": 3,
  "heading1": {
    "elements": [{ "text_run": { "content": "标题文字" } }]
  }
}
```

---

## 图片插入三步法（严格按顺序）

### Step 1：创建空图片块
```
POST /docx/v1/documents/{docId}/blocks/{docId}/children
Body: { "children": [{ "block_type": 27, "image": {} }], "index": -1 }
Response: { "data": { "children": [{ "block_id": "<图片块ID>" }] } }
```

### Step 2：上传图片
```
POST /drive/v1/medias/upload_all
Content-Type: multipart/form-data
Fields:
  file_name: "xxx.jpg"
  parent_type: "docx_image"    ← 必须是这个值
  parent_node: "<图片块ID>"    ← 图片块ID，不是文档ID！
  size: <文件字节数>
  file: <二进制文件内容>
Response: { "data": { "file_token": "xxx" } }
```

### Step 3：绑定图片
```
PATCH /docx/v1/documents/{docId}/blocks/{图片块ID}
Body: { "replace_image": { "token": "<file_token>" } }
```

---

## 限流策略

飞书 API 有频率限制，连续快速请求会返回空响应。

**推荐策略**：
- 每次请求前 `delay(400~500ms)`
- 遇到空响应时指数退避重试（1s → 2s → 3s）
- 最大重试 3 次

---

## 所需权限清单

| 权限标识 | 用途 |
|---|---|
| `docx:document` | 创建和读写文档 |
| `drive:drive` | 云空间文件操作 |
| `drive:file` | 文件上传管理 |
