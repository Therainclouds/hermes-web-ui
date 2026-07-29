from __future__ import annotations

from pydantic import BaseModel, Field


class ASRConfig(BaseModel):
    dashscope_api_key: str = ""
    paraformer_ws_url: str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    paraformer_model: str = "paraformer-realtime-v2"
    paraformer_sample_rate: int = 16000
    paraformer_format: str = "pcm"
    paraformer_language_hints: str = "zh,en"
    paraformer_semantic_punctuation: bool = True


class LLMConfig(BaseModel):
    api_key: str = ""
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-chat"
    temperature: float = 0.7
    max_tokens: int = 4096


class AnalysisConfig(BaseModel):
    interval_seconds: int = Field(default=60, ge=10, le=600)
    auto_start: bool = False
    custom_prompt: str | None = None


class AllConfig(BaseModel):
    asr: ASRConfig = Field(default_factory=ASRConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    analysis: AnalysisConfig = Field(default_factory=AnalysisConfig)


class AnalysisResult(BaseModel):
    summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    action_items: list[str] = Field(default_factory=list)
    people_mentioned: list[str] = Field(default_factory=list)
    relationships: list[dict] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    should_update_html: bool = False
    html_content: str | None = None
    timestamp: float = 0.0


class AnalysisStatus(BaseModel):
    is_running: bool = False
    last_update: float = 0.0
    total_analyses: int = 0
    current_interval: int = 60
    error: str | None = None


class AnalysisRequest(BaseModel):
    interval_seconds: int = Field(default=60, ge=10, le=600)
    custom_prompt: str | None = None


class PromptTemplate(BaseModel):
    name: str
    description: str
    template: str


DEFAULT_PROMPTS = {
    "meeting_analysis": PromptTemplate(
        name="会议分析",
        description="分析会议内容，提取关键信息",
        template="""请分析以下会议转写内容，提取以下信息并以 JSON 格式返回：

{
  "summary": "会议摘要（150字以内）",
  "key_points": ["关键要点1", "关键要点2", ...],
  "action_items": ["待办事项1", "待办事项2", ...],
  "people_mentioned": ["人名1", "人名2", ...],
  "relationships": [{"source": "人名A", "target": "人名B", "relation": "关系描述"}, ...],
  "topics": ["主题1", "主题2", ...]
}

注意：
- 如果信息不明确，对应字段返回空数组
- relationships 描述人物之间的协作、上下级等关系
- topics 是会议讨论的主要话题分类

会议内容：
{transcript}""",
    ),
    "html_generation": PromptTemplate(
        name="HTML生成",
        description="基于分析结果生成可视化HTML",
        template="""基于以下会议分析结果，生成一个完整的、可直接在浏览器中打开的 HTML 页面。

要求：
1. 使用 ECharts CDN (https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js)
2. 包含以下可视化组件：
   - 人物关系图（力导向图）：展示提到的人物及其关系
   - 关键要点列表：带图标的卡片式布局
   - 待办事项列表：可勾选的样式
   - 词云或主题标签：展示会议主题
3. 页面设计要求：
   - 现代简洁的 UI 风格
   - 响应式布局
   - 使用渐变色和阴影增加层次感
   - 中文字体优化
4. 页面标题：会议分析报告
5. 顶部显示会议摘要
6. 底部显示生成时间

只返回完整的 HTML 代码，不要有任何额外说明。

分析结果：
{analysis_json}""",
    ),
}
