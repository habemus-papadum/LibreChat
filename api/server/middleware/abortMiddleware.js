const { saveMessage, getConvo, getConvoTitle } = require('../../models');
const { sendMessage, handleError } = require('../utils');
const abortControllers = require('./abortControllers');

async function abortMessage(req, res) {
  const { abortKey } = req.body;
  console.log('req.body', req.body);
  if (!abortControllers.has(abortKey)) {
    return res.status(404).send('Request not found');
  }

  const { abortController } = abortControllers.get(abortKey);

  abortControllers.delete(abortKey);
  const ret = await abortController.abortAsk();
  console.log('Aborted request', abortKey);

  res.send(JSON.stringify(ret));
}

const handleAbort = () => {
  return async (req, res) => {
    try {
      return await abortMessage(req, res);
    } catch (err) {
      console.error(err);
    }
  };
};

const createAbortController = (res, req, endpointOption, getAbortData) => {
  const abortController = new AbortController();
  const onStart = (userMessage) => {
    sendMessage(res, { message: userMessage, created: true });
    abortControllers.set(userMessage.conversationId, { abortController, ...endpointOption });

    res.on('finish', function () {
      abortControllers.delete(userMessage.conversationId);
    });
  };

  abortController.abortAsk = async function () {
    this.abort();
    const { conversationId, userMessage, ...responseData } = getAbortData();

    const responseMessage = {
      ...responseData,
      finish_reason: 'incomplete',
      model: endpointOption.modelOptions.model,
      unfinished: false,
      cancelled: true,
      error: false,
    };

    saveMessage(responseMessage);

    return {
      title: await getConvoTitle(req.user.id, conversationId),
      final: true,
      conversation: await getConvo(req.user.id, conversationId),
      requestMessage: userMessage,
      responseMessage: responseMessage,
    };
  };

  return { abortController, onStart };
};

const handleAbortError = async (res, req, error, data) => {
  console.error(error);

  const { sender, conversationId, messageId, parentMessageId, partialText } = data;
  if (partialText?.length > 2) {
    return await abortMessage(req, res);
  } else {
    const errorMessage = {
      sender,
      messageId,
      conversationId,
      parentMessageId,
      unfinished: false,
      cancelled: false,
      error: true,
      text: error.message,
    };
    if (abortControllers.has(conversationId)) {
      abortControllers.delete(conversationId);
    }
    await saveMessage(errorMessage);
    handleError(res, errorMessage);
  }
};

module.exports = {
  handleAbort,
  createAbortController,
  handleAbortError,
};
