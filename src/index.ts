/**
 * CodeBuddy Enhance — VS Code 扩展入口
 *
 * 此文件作为 package.json "main" 字段指向的入口点，
 * 负责将 activate / deactivate 暴露给 VS Code 运行时。
 */

// Barrel exports（供外部引用）
export * from './types';
export * from './utils';
export * from './core';
export * from './storage';
export * from './renderer';

// 插件生命周期入口（必须导出）
export { activate, deactivate } from './vsextension';
