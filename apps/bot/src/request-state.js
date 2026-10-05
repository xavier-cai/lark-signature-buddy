export function mergeRequestState(
  previous,
  {
    imageKeys = [],
    recipeTokens = [],
    messageId,
    now = Date.now(),
  },
) {
  const retainedState =
    previous?.image || previous?.recipeToken ? previous : null;
  if (imageKeys.length > 1) {
    return {
      state: retainedState,
      status: 'invalid',
      message: `切图请求无效：每次只能提供 1 张原图片，收到 ${imageKeys.length} 张。`,
    };
  }
  if (recipeTokens.length > 1) {
    return {
      state: retainedState,
      status: 'invalid',
      message: `切图请求无效：每次只能提供 1 段配置字符串，收到 ${recipeTokens.length} 段。`,
    };
  }
  if (imageKeys.length === 0 && recipeTokens.length === 0) {
    return {
      state: retainedState,
      status: 'invalid',
      message: '未识别到原图片或配置字符串，请发送图片和以 LSB1: 开头的配置字符串。',
    };
  }

  const state = {
    ...previous,
    updatedAt: now,
  };
  if (imageKeys[0]) {
    state.image = {
      imageKey: imageKeys[0],
      messageId,
    };
  }
  if (recipeTokens[0]) state.recipeToken = recipeTokens[0];

  if (state.image && state.recipeToken) {
    return {
      state: null,
      status: 'ready',
      request: state,
      message: '已收到原图片和配置字符串，正在处理。',
    };
  }
  if (state.image) {
    return {
      state,
      status: 'waiting_recipe',
      message: '已收到原图片，等待配置字符串（以 LSB1: 开头）。',
    };
  }
  return {
    state,
    status: 'waiting_image',
    message: '已收到配置字符串，等待原图片。',
  };
}
