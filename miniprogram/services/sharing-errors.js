function cloudError(cause) {
  const detail = String(cause && (cause.errMsg || cause.message) || '');
  let code = 'SHARING_CALL_FAILED', message = '每周分享服务暂不可用，请联系高创。';
  if (/FUNCTION_NOT_FOUND|function(?:name)?[^\n]*(?:not found|not exist|could not be found)|FunctionName parameter could not be found|云函数不存在|未找到.*云函数/i.test(detail)) {
    code = 'SHARING_NOT_DEPLOYED'; message = '每周分享尚未启用，请联系高创完成初始化。';
  } else if (/ENV_NOT_FOUND|INVALID_ENV|environment[^\n]*(?:not found|not exist)|环境不存在/i.test(detail)) {
    code = 'SHARING_ENV_UNAVAILABLE'; message = '每周分享服务环境暂不可用，请联系高创。';
  } else if (/FUNCTIONS_EXECUTE_FAIL|FUNCTION_EXECUTE_FAIL|FUNCTION_EXECUTE_ERROR|云函数执行失败|Cannot find module/i.test(detail)) {
    code = 'SHARING_SERVICE_FAILED'; message = '每周分享服务异常，请联系高创处理。';
  } else if (/timeout|timed out|超时/i.test(detail)) {
    code = 'SHARING_TIMEOUT'; message = '每周分享读取超时，请稍后重试。';
  } else if (/network|request:fail|ENOTFOUND|ECONNRESET|ECONNREFUSED|网络|连接失败/i.test(detail)) {
    code = 'SHARING_NETWORK_FAILED'; message = '网络连接失败，请检查网络后重试。';
  }
  const error = new Error(message);
  error.code = code;
  error.sourceCode = cause && (cause.errCode || cause.code) || '';
  return error;
}
module.exports = { cloudError };
