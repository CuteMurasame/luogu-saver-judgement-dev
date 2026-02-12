
import * as cheerio from "cheerio";
import { ExternalServiceError } from "./errors.js";

export function getResponseObject(response, type = 0) {
	if (!type) {
		const $ = cheerio.load(response.data);
		const contextElement = $('#lentille-context');
		if (!contextElement.length) throw new ExternalServiceError("文章结构出错", "Luogu API");
		const dataObj = JSON.parse(contextElement.text().trim());
		return dataObj.data?.article;
	}
	else if (type === 1) {
		return response.data?.currentData?.paste;
	}
	else if (type === 3) {
		// For judgement, handle both direct JSON response and HTML with lentille-context
		const responseData = response.data;
		
		// 检查响应是否是直接JSON
		if (typeof responseData === 'object' && responseData !== null) {
			// 已经是对象，可能是直接API响应
			logger.debug('陶片放逐响应是直接JSON对象');
			
			// 检查是否是预期的数据结构
			if (responseData.data && responseData.data.logs && Array.isArray(responseData.data.logs)) {
				logger.debug(`陶片放逐 API 返回 ${responseData.data.logs.length} 条记录`);
				return responseData.data;
			} else if (responseData.logs && Array.isArray(responseData.logs)) {
				// 如果logs在顶层
				logger.debug(`陶片放逐 API 返回 ${responseData.logs.length} 条记录（顶层logs）`);
				return responseData;
			} else {
				// 尝试从常见路径查找数据
				const possiblePaths = ['data', 'currentData', 'result'];
				for (const path of possiblePaths) {
					if (responseData[path] && responseData[path].logs && Array.isArray(responseData[path].logs)) {
						logger.debug(`从路径 ${path} 找到logs数组，长度: ${responseData[path].logs.length}`);
						return responseData[path];
					}
				}
				
				// 没有找到预期的结构，记录并尝试作为HTML处理
				logger.warn('陶片放逐JSON响应结构异常，尝试作为HTML处理');
				logger.debug('响应结构:', JSON.stringify(responseData, null, 2).substring(0, 1000));
			}
		}
		
		// 如果不是直接JSON或结构不符合预期，尝试作为HTML处理
		if (typeof responseData === 'string') {
			// 检查是否是HTML
			if (responseData.includes('<!DOCTYPE') || responseData.includes('<html') || responseData.includes('lentille-context')) {
				logger.debug('陶片放逐响应是HTML，尝试解析lentille-context');
				const $ = cheerio.load(responseData);
				const contextElement = $('#lentille-context');
				if (!contextElement.length) {
					logger.error('陶片放逐HTML中未找到lentille-context元素');
					throw new ExternalServiceError("陶片放逐页面结构出错", "Luogu API");
				}
				
				let dataObj;
				try {
					dataObj = JSON.parse(contextElement.text().trim());
				} catch (parseError) {
					throw new ExternalServiceError(`解析陶片放逐页面JSON失败: ${parseError.message}`, "Luogu API");
				}
				
				const getLogsFromObj = (candidate) => {
					if (!candidate || typeof candidate !== 'object') return null;
					if (candidate.logs && Array.isArray(candidate.logs)) return candidate;
					if (candidate.data && Array.isArray(candidate.data.logs)) return candidate.data;
					if (candidate.currentData && Array.isArray(candidate.currentData.logs)) return candidate.currentData;
					return null;
				};
				const hasLogs = (value) => value?.logs && Array.isArray(value.logs);
				const tryExtractLogsFromElement = (el, selector, elementIndex) => {
					const text = $(el).text().trim();
					if (!text) return false;
					try {
						const parsed = JSON.parse(text);
						const logsObj = getLogsFromObj(parsed);
						if (logsObj) {
							result = logsObj;
							logger.debug(`从 ${selector} 提取到 ${result.logs.length} 条陶片放逐记录`);
							return true;
						}
					} catch (parseError) {
						logger.debug(`解析 ${selector} JSON 失败 (元素 ${elementIndex}): ${parseError.message}`);
					}
					return false;
				};
				
				// 修正数据路径：应该从 dataObj.data 而不是 dataObj.currentData 获取
				let result = getLogsFromObj(dataObj.data);
				
				if (hasLogs(result)) {
					logger.debug(`陶片放逐 HTML 解析返回 ${result.logs.length} 条记录`);
				} else {
					// 兼容新版 lentille 拆分数据：data 里存的是状态索引
					const LENTILLE_STATE_INDEX_KEY = ':'; // Lentille 使用 ':' 作为状态索引的键名（如对应 #lentille-state-0）
					const stateIndex = typeof dataObj?.data?.[LENTILLE_STATE_INDEX_KEY] === 'number' ? dataObj.data[LENTILLE_STATE_INDEX_KEY] : undefined;
					const fallbackSelectors = [];
					if (stateIndex !== undefined) {
						fallbackSelectors.push(`#lentille-state-${stateIndex}`, `#lentille-data-${stateIndex}`);
					}
					fallbackSelectors.push('script[type="application/json"]');
					
					const extractLogsFromSelectors = (selectors) => {
						for (const selector of selectors) {
							const elementArray = $(selector).toArray();
							for (let elementIndex = 0; elementIndex < elementArray.length; elementIndex++) {
								if (hasLogs(result)) return true;
								if (tryExtractLogsFromElement(elementArray[elementIndex], selector, elementIndex)) return true;
							}
						}
						return hasLogs(result);
					};
					
					extractLogsFromSelectors(fallbackSelectors);
					
					if (!hasLogs(result)) {
						result = result || {};
						result.logs = result.logs || [];
						const resultStr = JSON.stringify(result, null, 2) || '';
						logger.debug('陶片放逐数据结构异常: ' + resultStr.substring(0, 1000));
						logger.debug('dataObj 完整结构: ' + JSON.stringify(dataObj, null, 2).substring(0, 1000));
					}
				}
				return result;
			} else {
				// 可能是JSON字符串
				try {
					const jsonData = JSON.parse(responseData);
					logger.debug('陶片放逐响应是JSON字符串，已解析');
					
					// 递归处理解析后的对象
					const fakeResponse = { data: jsonData };
					return getResponseObject(fakeResponse, type);
				} catch (parseError) {
					logger.error('陶片放逐响应既不是HTML也不是有效JSON');
					throw new ExternalServiceError(`陶片放逐响应解析失败: ${parseError.message}`, "Luogu API");
				}
			}
		}
		
		// 如果到达这里，说明无法处理响应
		logger.error('无法处理陶片放逐响应，类型:', typeof responseData);
		throw new ExternalServiceError("无法处理陶片放逐响应", "Luogu API");
	}
	else if (type === 4) {
		// For user profile, parse HTML like articles
		const $ = cheerio.load(response.data);
		const contextElement = $('#lentille-context');
		if (!contextElement.length) throw new ExternalServiceError("用户页面结构出错", "Luogu API");
		const dataObj = JSON.parse(contextElement.text().trim());
		return dataObj.data?.user;
	}
}

export function getResponseUser(response) {
	const author = response.author || response.user || {};
	return {
		uid: parseInt(author.uid),
		name: author.name,
		color: author.color
	};
}
