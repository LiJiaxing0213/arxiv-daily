"""Topic definitions and arXiv categories to search."""

# arXiv categories to query
ARXIV_CATEGORIES = ["cs.AI", "cs.LG", "cs.CV", "cs.CL", "cs.GR"]

# How many days back to look (arxiv may post papers a day late)
LOOKBACK_DAYS = 2

# Max results to fetch per category per query (arxiv API limit per req is 2000, but be polite)
MAX_RESULTS_PER_CATEGORY = 200

# Topic definitions: each paper is matched against these keywords (case-insensitive,
# searched in title + abstract). A paper can belong to multiple topics.
TOPICS = {
    "world-model": {
        "name_zh": "世界模型",
        "name_en": "World Models",
        "keywords": [
            "world model", "world models", "world simulator",
            "dynamics model", "neural simulator", "learned simulator",
            "predictive world", "generative world",
        ],
    },
    "rl": {
        "name_zh": "强化学习",
        "name_en": "Reinforcement Learning",
        "keywords": [
            "reinforcement learning", "rlhf", "rlvr", "rlaif",
            "policy optimization", "policy gradient", "ppo", "grpo", "dpo",
            "actor-critic", "q-learning", "reward model", "reward shaping",
            "offline rl", "online rl", "model-based rl",
        ],
    },
    "distillation": {
        "name_zh": "模型蒸馏",
        "name_en": "Distillation",
        "keywords": [
            "knowledge distillation", "model distillation", "distill",
            "teacher-student", "teacher model", "student model",
            "self-distillation",
        ],
    },
    "video-gen": {
        "name_zh": "视频生成",
        "name_en": "Video Generation",
        "keywords": [
            "video generation", "video diffusion", "text-to-video",
            "image-to-video", "video synthesis", "video editing",
            "video model", "video foundation model", "long video",
        ],
    },
    "4d-gen": {
        "name_zh": "4D 生成",
        "name_en": "4D Generation",
        "keywords": [
            "4d generation", "4d scene", "4d reconstruction",
            "dynamic 3d", "dynamic scene", "dynamic gaussian",
            "4d gaussian", "spacetime", "space-time",
        ],
    },
}
