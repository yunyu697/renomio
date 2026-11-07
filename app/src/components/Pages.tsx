import { useApp } from '../store';
import { ImagePage, MusicPage, OfficePage } from './MetaPages';
import { AttrsPage, OrganizePage, TimesPage } from './OpsPages';
import { TextEncodingPage } from './TextEncodingPage';

/** 侧栏功能页路由：每个入口都是完整页面（自带选择区/空态/编辑/结果）。 */
export function Pages() {
  const activePage = useApp((s) => s.activePage);
  switch (activePage) {
    case 'music':
      return <MusicPage />;
    case 'image':
      return <ImagePage />;
    case 'office':
      return <OfficePage />;
    case 'text':
      return <TextEncodingPage />;
    case 'attrs':
      return <AttrsPage />;
    case 'times':
      return <TimesPage />;
    case 'organize':
      return <OrganizePage />;
    default:
      return null;
  }
}
