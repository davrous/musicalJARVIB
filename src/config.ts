// Configuration - The new Teams SDK reads BOT_ID/BOT_PASSWORD from env vars automatically.
// These are kept for reference and for direct Azure OpenAI API usage.
const config = {
  azureOpenAIKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAIDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "gpt-4o",
  deepSeekApiKey: process.env.AZURE_DEEPSEEK_API_KEY || "",
};

export default config;
