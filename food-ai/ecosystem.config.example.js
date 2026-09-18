// 复制为 ecosystem.config.js 后填入自己的密钥：
//   cp ecosystem.config.example.js ecosystem.config.js
// 然后：pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'food-ai',
      script: 'service.py',
      interpreter: '/home/ubuntu/yolo-env/bin/python',
      cwd: '/home/ubuntu/food-ai',
      env: {
        FOOD_AI_PORT: '5003',
        OMP_NUM_THREADS: '2',
        MKL_NUM_THREADS: '2',
        // 拍照识别（Qwen-VL，DashScope）
        DASHSCOPE_API_KEY: '',
        QWEN_VL_MODEL: 'qwen3-vl-flash',
        // 添加页「询问 AI」（Doubao，火山方舟 Ark）
        ARK_API_KEY: '',
        ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
        DOUBAO_CHAT_MODEL: 'doubao-seed-2-1-pro-260628',
        DOUBAO_THINKING: 'disabled',
        // 排查用：保存抠图等中间结果到 logs/debug，调完可删
        FOOD_AI_DEBUG_DIR: '/home/ubuntu/food-ai/logs/debug',
        // 美图 AI 开放平台智能抠图（可选，优先通道）
        MEITU_OPEN_AK: '',
        MEITU_OPEN_SK: '',
        FOOD_MEITU_OPEN: '1',
        FOOD_MEITU_OPEN_MODEL_TYPE: '1',
        // MeituHub（meituhub.cn）image-cutout（可选）
        MEITU_OPENAPI_ACCESS_KEY: '',
        MEITU_OPENAPI_SECRET_KEY: '',
        FOOD_MEITU_CUTOUT: '1',
        FOOD_MEITU_MODEL_TYPE: '1',
      },
      max_memory_restart: '2000M',
      max_restarts: 10,
      restart_delay: 5000,
      error_file: '/home/ubuntu/food-ai/logs/pm2-error.log',
      out_file: '/home/ubuntu/food-ai/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
