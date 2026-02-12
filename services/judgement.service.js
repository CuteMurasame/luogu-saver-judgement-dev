import Judgement from "../models/judgement.js";
import User from "../models/user.js";
import { withCache, invalidateCache, invalidateCacheByPattern } from "../core/cache.js";
import { ExternalServiceError, logError, SystemError } from "../core/errors.js";
import { In } from "typeorm";
import { formatDate } from "../core/utils.js";
import config from "../config.js";

/**
 * 保存陶片放逐记录
 * 
 * 批量保存从洛谷获取的陶片放逐记录，跳过已存在的记录。
 * 保存完成后会自动使相关缓存失效。
 * 
 * @param {Object} task - 包含任务元数据的任务对象
 * @param {Object} obj - 陶片放逐数据对象
 * @param {Array} obj.logs - 陶片放逐记录数组
 */
export async function saveJudgements(task, obj) {
	if (!obj || typeof obj !== 'object') {
		throw new ExternalServiceError('陶片放逐数据对象为空或无效', 'Luogu API');
	}
	
	const logs = obj.logs || [];
	
	if (!Array.isArray(logs)) {
		throw new ExternalServiceError(`陶片放逐数据中 logs 不是数组类型，而是: ${typeof logs}`, 'Luogu API');
	}
	
	logger.debug(`获取到 ${logs.length} 条陶片放逐记录`);
	
	if (logs.length === 0) {
		logger.warn('没有获取到陶片放逐记录，可能是页面结构发生变化或当前没有新记录');
		return;
	}
	
	let savedCount = 0;
	let skippedCount = 0;
	let invalidCount = 0;
	let errorCount = 0;
	
	for (const log of logs) {
		if (!log || !log.user || !log.user.uid || !log.time) {
			logger.warn('跳过无效的陶片放逐记录：缺少必要字段');
			invalidCount++;
			continue;
		}
		
		try {
			const existing = await Judgement.findOne({
				where: {
					user_uid: log.user.uid,
					time: new Date(log.time * 1000)
				}
			});
			
			if (existing) {
				skippedCount++;
				continue;
			}
			
			const judgement = Judgement.create({
				user_uid: log.user.uid,
				reason: log.reason || null,
				permission_granted: log.addedPermission || 0,
				permission_revoked: log.revokedPermission || 0,
				time: new Date(log.time * 1000)
			});
			await judgement.save();
			savedCount++;
		} catch (saveError) {
			errorCount++;
			await logError(new SystemError(`保存陶片放逐记录失败 (用户 ${log.user.uid}): ${saveError.message}`), null);
		}
	}
	
	logger.info(`陶片放逐记录处理完成: 新保存 ${savedCount} 条，跳过 ${skippedCount} 条，无效 ${invalidCount} 条，失败 ${errorCount} 条`);
	
	if (savedCount > 0) {
		await Promise.all([
			invalidateCacheByPattern('recent_judgement_groups:*'),
			invalidateCache(['statistics:full', 'statistics:counts'])
		]);
	}
}

/**
 * 获取最新的陶片放逐记录（支持分页和缓存）
 * 
 * 检索最近的陶片放逐记录，按时间倒序排序。
 * 结果缓存 10 分钟以提高性能。
 * 
 * @param {Object} params - 分页参数
 * @param {number|string} [params.page=1] - 分页页码
 * @param {number|string} [params.per_page=10] - 每页记录数
 * @returns {Promise<Object>} 包含 judgements 数组、分页信息的对象
 */
export async function getRecentJudgements({ page, per_page }) {
	const currentPage = Math.max(parseInt(page) || 1, 1);
	const perPage = per_page || config.pagination.judgement;
	
	const cacheKey = `recent_judgement_groups:${currentPage}:${perPage}`;
	
	return await withCache({
		cacheKey,
		ttl: 600,
		fetchFn: async () => {
			const offset = (currentPage - 1) * perPage;
			const groupRows = await Judgement.createQueryBuilder('judgement')
				.select('judgement.permission_granted', 'permission_granted')
				.addSelect('judgement.permission_revoked', 'permission_revoked')
				.addSelect('judgement.reason', 'reason')
				.addSelect('MAX(judgement.time)', 'latest_time')
				.groupBy('judgement.permission_granted')
				.addGroupBy('judgement.permission_revoked')
				.addGroupBy('judgement.reason')
				.orderBy('latest_time', 'DESC')
				.skip(offset)
				.take(perPage)
				.getRawMany();

			const countRow = await Judgement.repository.manager.createQueryBuilder()
				.select('COUNT(*)', 'total')
				.from(subQuery => {
					return subQuery
						.select('1')
						.from(Judgement.repository.metadata.tableName, 'judgement')
						.groupBy('judgement.permission_granted')
						.addGroupBy('judgement.permission_revoked')
						.addGroupBy('judgement.reason');
				}, 'grouped')
				.getRawOne();
			const totalCount = Number(countRow?.total ?? 0);
			const totalPages = Math.ceil(totalCount / perPage);
			const judgementGroups = [];
			const groupMap = new Map();
			const buildGroupKey = (permissionGranted, permissionRevoked, reason) => (
				`${permissionGranted}:${permissionRevoked}:${reason ?? ''}`
			);

			for (const row of groupRows) {
				const permissionGranted = Number(row.permission_granted) || 0;
				const permissionRevoked = Number(row.permission_revoked) || 0;
				const reason = row.reason;
				const groupKey = buildGroupKey(permissionGranted, permissionRevoked, reason);
				const group = {
					reason,
					permission_granted: permissionGranted,
					permission_revoked: permissionRevoked,
					judgements: []
				};
				groupMap.set(groupKey, group);
				judgementGroups.push(group);
			}

			if (groupRows.length > 0) {
				const groupFilters = groupRows.map(row => ({
					permission_granted: Number(row.permission_granted) || 0,
					permission_revoked: Number(row.permission_revoked) || 0,
					reason: row.reason
				}));
				const judgements = await Judgement.find({
					where: groupFilters,
					order: { time: 'DESC' }
				});
				const userIds = [...new Set(judgements.map(judgement => judgement.user_uid).filter(Boolean))];
				const userMap = new Map();

				if (userIds.length > 0) {
					const users = await User.find({ where: { id: In(userIds) } });
					for (const user of users) {
						userMap.set(user.id, user);
					}
				}

				for (const judgement of judgements) {
					judgement.user = userMap.get(judgement.user_uid) || null;
					judgement.formatDate();
					const groupKey = buildGroupKey(
						judgement.permission_granted || 0,
						judgement.permission_revoked || 0,
						judgement.reason
					);
					groupMap.get(groupKey)?.judgements.push(judgement);
				}
			}

			return {
				judgements: judgementGroups,
				currentPage,
				totalPages,
				perPage,
				pageCount: totalPages
			};
		}
	});
}
