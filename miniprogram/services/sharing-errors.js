function cloudError(cause, { service = '每周分享', prefix = 'SHARING', contact = '高创', setup = '完成初始化' } = {}) {
  const detail = String(cause && (cause.errMsg || cause.message) || '');
  let code = 'CALL_FAILED', message = service + '服务暂不可用，请联系' + contact + '。';
  if (/FUNCTION_NOT_FOUND|function(?:name)?[^\n]*(?:not found|not exist|could not be found)|FunctionName parameter could not be found|云函数不存在|未找到.*云函数/i.test(detail)) {
    code = 'NOT_DEPLOYED'; message = service + '尚未启用，请联系' + contact + setup + '。';
  } else if (/ENV_NOT_FOUND|INVALID_ENV|environment[^\n]*(?:not found|not exist)|环境不存在/i.test(detail)) {
    code = 'ENV_UNAVAILABLE'; message = service + '服务环境暂不可用，请联系' + contact + '。';
  } else if (/FUNCTIONS_EXECUTE_FAIL|FUNCTION_EXECUTE_FAIL|FUNCTION_EXECUTE_ERROR|云函数执行失败|Cannot find module/i.test(detail)) {
    code = 'SERVICE_FAILED'; message = service + '服务异常，请联系' + contact + '处理。';
  } else if (/timeout|timed out|超时/i.test(detail)) {
    code = 'TIMEOUT'; message = service + '读取超时，请稍后重试。';
  } else if (/network|request:fail|ENOTFOUND|ECONNRESET|ECONNREFUSED|网络|连接失败/i.test(detail)) {
    code = 'NETWORK_FAILED'; message = '网络连接失败，请检查网络后重试。';
  }
  const error = new Error(message);
  error.code = prefix + '_' + code;
  error.sourceCode = cause && (cause.errCode || cause.code) || '';
  return error;
}
module.exports = { cloudError };
