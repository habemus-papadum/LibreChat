const { getUserPluginAuthValue } = require('../../../../server/services/PluginService');
const { OpenAIEmbeddings } = require('langchain/embeddings/openai');
const { ZapierToolKit } = require('langchain/agents');
const { SerpAPI, ZapierNLAWrapper } = require('langchain/tools');
const { ChatOpenAI } = require('langchain/chat_models/openai');
const { Calculator } = require('langchain/tools/calculator');
const { WebBrowser } = require('langchain/tools/webbrowser');
const {
  availableTools,
  AIPluginTool,
  GoogleSearchAPI,
  WolframAlphaAPI,
  StructuredWolfram,
  HttpRequestTool,
  OpenAICreateImage,
  StableDiffusionAPI,
  StructuredSD,
  E2BTools,
} = require('../');
const { loadSpecs } = require('./loadSpecs');

const getOpenAIKey = async (options, user) => {
  let openAIApiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY;
  openAIApiKey = openAIApiKey === 'user_provided' ? null : openAIApiKey;
  return openAIApiKey || (await getUserPluginAuthValue(user, 'OPENAI_API_KEY'));
};

const validateTools = async (user, tools = []) => {
  try {
    const validToolsSet = new Set(tools);
    const availableToolsToValidate = availableTools.filter((tool) =>
      validToolsSet.has(tool.pluginKey),
    );

    const validateCredentials = async (authField, toolName) => {
      const adminAuth = process.env[authField];
      if (adminAuth && adminAuth.length > 0) {
        return;
      }

      const userAuth = await getUserPluginAuthValue(user, authField);
      if (userAuth && userAuth.length > 0) {
        return;
      }
      validToolsSet.delete(toolName);
    };

    for (const tool of availableToolsToValidate) {
      if (!tool.authConfig || tool.authConfig.length === 0) {
        continue;
      }

      for (const auth of tool.authConfig) {
        await validateCredentials(auth.authField, tool.pluginKey);
      }
    }

    return Array.from(validToolsSet.values());
  } catch (err) {
    console.log('There was a problem validating tools', err);
    throw new Error(err);
  }
};

const loadToolWithAuth = async (user, authFields, ToolConstructor, options = {}) => {
  return async function () {
    let authValues = {};

    for (const authField of authFields) {
      let authValue = process.env[authField];
      if (!authValue) {
        authValue = await getUserPluginAuthValue(user, authField);
      }
      authValues[authField] = authValue;
    }

    return new ToolConstructor({ ...options, ...authValues });
  };
};

const loadTools = async ({ user, model, functions = null, tools = [], options = {} }) => {
  const toolConstructors = {
    calculator: Calculator,
    google: GoogleSearchAPI,
    wolfram: functions ? StructuredWolfram : WolframAlphaAPI,
    'dall-e': OpenAICreateImage,
    'stable-diffusion': functions ? StructuredSD : StableDiffusionAPI,
  };

  const openAIApiKey = await getOpenAIKey(options, user);

  const customConstructors = {
    e2b_code_interpreter: async () => {
      if (!functions) {
        return null;
      }
      const suite = [];
      let serverUrl = process.env.E2B_SERVER_URL;

      if (!serverUrl) {
        serverUrl = await getUserPluginAuthValue(user, 'E2B_SERVER_URL');
      }

      for (const tool of E2BTools) {
        suite.push(
          new tool({
            E2B_SERVER_URL: serverUrl,
            conversationId: options.conversationId,
            model,
            openAIApiKey,
          }),
        );
      }

      return suite;
    },
    'web-browser': async () => {
      // let openAIApiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY;
      // openAIApiKey = openAIApiKey === 'user_provided' ? null : openAIApiKey;
      // openAIApiKey = openAIApiKey || (await getUserPluginAuthValue(user, 'OPENAI_API_KEY'));
      return new WebBrowser({ model, embeddings: new OpenAIEmbeddings({ openAIApiKey }) });
    },
    serpapi: async () => {
      let apiKey = process.env.SERPAPI_API_KEY;
      if (!apiKey) {
        apiKey = await getUserPluginAuthValue(user, 'SERPAPI_API_KEY');
      }
      return new SerpAPI(apiKey, {
        location: 'Austin,Texas,United States',
        hl: 'en',
        gl: 'us',
      });
    },
    zapier: async () => {
      let apiKey = process.env.ZAPIER_NLA_API_KEY;
      if (!apiKey) {
        apiKey = await getUserPluginAuthValue(user, 'ZAPIER_NLA_API_KEY');
      }
      const zapier = new ZapierNLAWrapper({ apiKey });
      return ZapierToolKit.fromZapierNLAWrapper(zapier);
    },
    plugins: async () => {
      return [
        new HttpRequestTool(),
        await AIPluginTool.fromPluginUrl(
          'https://www.klarna.com/.well-known/ai-plugin.json',
          new ChatOpenAI({ openAIApiKey: options.openAIApiKey, temperature: 0 }),
        ),
      ];
    },
  };

  const requestedTools = {};
  let specs = null;
  if (functions) {
    specs = await loadSpecs({
      llm: model,
      user,
      message: options.message,
      map: true,
      verbose: options?.debug,
    });
    console.dir(specs, { depth: null });
  }

  const toolOptions = {
    serpapi: { location: 'Austin,Texas,United States', hl: 'en', gl: 'us' },
  };

  const toolAuthFields = {};

  availableTools.forEach((tool) => {
    if (customConstructors[tool.pluginKey]) {
      return;
    }

    toolAuthFields[tool.pluginKey] = tool.authConfig.map((auth) => auth.authField);
  });

  for (const tool of tools) {
    if (customConstructors[tool]) {
      requestedTools[tool] = customConstructors[tool];
      continue;
    }

    if (specs && specs[tool]) {
      requestedTools[tool] = specs[tool];
      continue;
    }

    if (toolConstructors[tool]) {
      const options = toolOptions[tool] || {};
      const toolInstance = await loadToolWithAuth(
        user,
        toolAuthFields[tool],
        toolConstructors[tool],
        options,
      );
      requestedTools[tool] = toolInstance;
    }
  }

  return requestedTools;
};

module.exports = {
  validateTools,
  loadTools,
};
