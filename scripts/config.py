"""Topic definitions and arXiv categories to search."""

# arXiv categories to query
ARXIV_CATEGORIES = ["cs.AI", "cs.LG", "cs.CV", "cs.CL", "cs.GR"]

# How many days back to look. We'll group papers by their published date and
# keep one JSON file per date.
LOOKBACK_DAYS = 8  # today + 7 previous days

# Number of recent dates to retain in data/ (older files get deleted).
RETENTION_DAYS = 8

# Max results to fetch per category per query.
MAX_RESULTS_PER_CATEGORY = 400

# Keywords that, if found ANYWHERE in title/abstract, disqualify the paper
# regardless of topic match. Useful to filter out off-target matches like
# "replay buffer" applied to quantum circuits.
GLOBAL_EXCLUDE = [
    "quantum circuit", "quantum computing", "qubit",
    "molecular dynamics simulation",  # not the AI sense of "world model"
    "fluid dynamics simulation",
]

# Topic definitions: each paper is matched against these keywords (case-insensitive,
# searched in title + abstract). A paper can belong to multiple topics.
# Each topic can also have an `exclude` list to filter out false positives.
TOPICS = {
    "world-model": {
        "name_zh": "世界模型",
        "name_en": "World Models",
        "keywords": [
            "world model", "world models", "world simulator",
            "neural simulator", "learned simulator",
            "predictive world", "generative world",
            "video world model", "interactive world",
        ],
        "exclude": [],
    },
    "rl": {
        "name_zh": "强化学习",
        "name_en": "Reinforcement Learning",
        "keywords": [
            # Core RL theory / algorithms
            "reinforcement learning", "policy gradient", "policy optimization",
            "actor-critic", "actor critic", "q-learning",
            "ppo", "trpo", "sac", "dqn", "td3", "a3c",
            "offline reinforcement", "model-based reinforcement",
            "model-based rl", "offline rl",
            # RL for LLMs / alignment
            "rlhf", "rlaif", "rlvr", "dpo", "grpo", "ipo", "kto",
            "reward model", "reward modeling", "reward shaping",
            "preference optimization", "preference learning",
            # RL for diffusion / flow matching (the user's specific interest)
            "ddpo", "dpok", "diffusion policy",
            "reward-weighted diffusion", "rl fine-tuning",
            "reinforcement fine-tuning",
            "flow matching", "rectified flow",
        ],
        "exclude": [
            # Filter out unrelated uses of RL terminology
            "quantum", "circuit optimization", "robot navigation only",
            "wireless", "power grid", "traffic signal",
            "stock", "trading strategy", "portfolio",
        ],
    },
    "distillation": {
        "name_zh": "模型蒸馏",
        "name_en": "Distillation",
        "keywords": [
            # General distillation
            "knowledge distillation", "model distillation", "distill",
            "teacher-student", "teacher model", "student model",
            "self-distillation",
            # Diffusion / video / image distillation
            "diffusion distillation", "consistency model", "consistency models",
            "consistency distillation", "step distillation",
            "one-step generation", "few-step generation",
            "progressive distillation", "score distillation",
            "video distillation", "image distillation",
            # LLM distillation
            "llm distillation", "speculative decoding",
            "small language model", "compact model",
        ],
        "exclude": [
            "data distillation",  # usually means dataset distillation, different topic
            "feature distillation in chemistry",
        ],
    },
    "video-gen": {
        "name_zh": "视频生成",
        "name_en": "Video Generation",
        "keywords": [
            "video generation", "video diffusion", "text-to-video",
            "image-to-video", "video synthesis", "video editing",
            "video model", "video foundation model", "long video",
            "video generative model", "controllable video",
            "video dit", "video transformer",
        ],
        "exclude": [
            "video classification only", "video retrieval only",
        ],
    },
    "4d-gen": {
        "name_zh": "4D 生成",
        "name_en": "4D Generation",
        "keywords": [
            "4d generation", "4d scene", "4d reconstruction",
            "dynamic 3d", "dynamic scene", "dynamic gaussian",
            "4d gaussian", "4d gaussian splatting",
            "spacetime", "space-time",
            "deformable gaussian", "animatable",
            "dynamic nerf", "4d nerf",
        ],
        "exclude": [],
    },
}
