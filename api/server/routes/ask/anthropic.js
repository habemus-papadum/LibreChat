const express = require('express');
const router = express.Router();
const { getResponseSender } = require('librechat-data-provider');
const { buildOptions, initializeClient } = require('../endpoints/anthropic');
const {
  handleAbort,
  createAbortController,
  handleAbortError,
  requireJwtAuth,
  validateEndpoint,
  setHeaders,
} = require('../../middleware');
const { saveMessage, getConvoTitle, saveConvo, getConvo } = require('../../../models');
const { sendMessage, createOnProgress } = require('../../utils');

router.post('/abort', requireJwtAuth, handleAbort());

router.post('/', requireJwtAuth, validateEndpoint, setHeaders, async (req, res) => {
  let { text, conversationId, parentMessageId = null, overrideParentMessageId = null } = req.body;
  const endpointOption = buildOptions(req);
  console.log('ask log');
  console.dir({ text, conversationId, endpointOption }, { depth: null });
  let userMessage;
  let userMessageId;
  let responseMessageId;
  let lastSavedTimestamp = 0;

  const getIds = (data) => {
    userMessage = data.userMessage;
    userMessageId = data.userMessage.messageId;
    responseMessageId = data.responseMessageId;
    if (!conversationId) {
      conversationId = data.conversationId;
    }
  };

  const { onProgress: progressCallback, getPartialText } = createOnProgress({
    onProgress: ({ text: partialText }) => {
      const currentTimestamp = Date.now();
      if (currentTimestamp - lastSavedTimestamp > 500) {
        lastSavedTimestamp = currentTimestamp;
        saveMessage({
          messageId: responseMessageId,
          sender: getResponseSender(endpointOption),
          conversationId,
          parentMessageId: overrideParentMessageId || userMessageId,
          text: partialText,
          unfinished: true,
          cancelled: false,
          error: false,
        });
      }
    },
  });
  try {
    const getAbortData = () => ({
      conversationId,
      messageId: responseMessageId,
      sender: getResponseSender(endpointOption),
      parentMessageId: overrideParentMessageId ?? userMessageId,
      text: getPartialText(),
      userMessage,
    });

    const { abortController, onStart } = createAbortController(
      res,
      req,
      endpointOption,
      getAbortData,
    );

    const { client } = initializeClient(req, endpointOption);

    let response = await client.sendMessage(text, {
      getIds,
      debug: false,
      user: req.user.id,
      conversationId,
      parentMessageId,
      overrideParentMessageId,
      ...endpointOption,
      onProgress: progressCallback.call(null, {
        res,
        text,
        parentMessageId: overrideParentMessageId || userMessageId,
      }),
      onStart,
      abortController,
    });

    if (overrideParentMessageId) {
      response.parentMessageId = overrideParentMessageId;
    }

    await saveConvo(req.user.id, {
      ...endpointOption,
      ...endpointOption.modelOptions,
      conversationId,
      endpoint: 'anthropic',
    });

    await saveMessage(response);
    sendMessage(res, {
      title: await getConvoTitle(req.user.id, conversationId),
      final: true,
      conversation: await getConvo(req.user.id, conversationId),
      requestMessage: userMessage,
      responseMessage: response,
    });
    res.end();

    // TODO: add anthropic titling
  } catch (error) {
    const partialText = getPartialText();
    handleAbortError(res, req, error, {
      partialText,
      conversationId,
      sender: getResponseSender(endpointOption),
      messageId: responseMessageId,
      parentMessageId: userMessageId,
    });
  }
});

module.exports = router;
