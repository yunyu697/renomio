/** 新增规则时的默认值：与设计稿“规则配置”保持一致 */
import type {
  AddRule, CaseRule, DeleteRule, ExtRule, MetaRule, MoveRule, NumberRule, ReplaceRule, Rule, RuleType,
} from './types';

export function createRuleDefaults(type: RuleType, id: string): Rule {
  switch (type) {
    case 'add': {
      const rule: AddRule = {
        id, type: 'add', enabled: true,
        mode: 'direct', text: '前缀_', anchor: 'start', position: 1, fromEnd: false,
        padTo: 4, padChar: '0',
      };
      return rule;
    }
    case 'replace': {
      const rule: ReplaceRule = {
        id, type: 'replace', enabled: true,
        find: ' ', replace: '_', caseSensitive: false, regex: false, nth: 0,
      };
      return rule;
    }
    case 'delete': {
      const rule: DeleteRule = {
        id, type: 'delete', enabled: true,
        mode: 'trim', from: 1, fromEnd: false, count: 3,
        left: '[', right: ']', includeLeft: true, includeRight: true,
        chars: '', keep: false,
      };
      return rule;
    }
    case 'number': {
      const rule: NumberRule = {
        id, type: 'number', enabled: true,
        expression: '<#>', start: 1, step: 1, digits: 3, padChar: '0',
        groupBy: 'parent', exclude: '', byPath: false, writeVar: '', onlyChecked: false,
      };
      return rule;
    }
    case 'move': {
      const rule: MoveRule = {
        id, type: 'move', enabled: true,
        from: 1, fromEnd: false, count: 2, to: 1, toEnd: false,
      };
      return rule;
    }
    case 'case': {
      const rule: CaseRule = {
        id, type: 'case', enabled: true, mode: 'lower', separators: ' -_.',
      };
      return rule;
    }
    case 'ext': {
      const rule: ExtRule = {
        id, type: 'ext', enabled: true, mode: 'case', value: '', position: 'suffix', caseMode: 'lower',
      };
      return rule;
    }
    case 'meta': {
      const rule: MetaRule = {
        id, type: 'meta', enabled: true, field: 'taken', mode: 'prefix', separator: ' ',
      };
      return rule;
    }
    default:
      throw new Error(`未知规则类型：${String(type)}`);
  }
}

export const RULE_TYPES: RuleType[] = ['replace', 'add', 'delete', 'number', 'move', 'case', 'ext', 'meta'];
