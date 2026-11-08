/**
 * Next 服务端启动钩子（只在 Node 侧执行，前端 bundle 不含这里）。
 *
 * 唯一职责：让「自签证书 / 不合法证书链」的上游源能播。
 * 大量个人 IPTV、内网 Emby/Jellyfin、自建采集站都是 https + 自签证书，
 * fetch 会在 TLS 握手阶段直接失败，表现为源「连不上」而不是报证书。
 *
 * 默认行为不变（严格校验）；只有部署者显式设置 MFL_ALLOW_INSECURE_TLS=1
 * 才关闭校验 —— 这是有意的 opt-in：关掉校验后公网站点也存在被劫持的风险，
 * 只在自己确认过上游的情况下开。
 */
export async function register() {
  if (process.env.MFL_ALLOW_INSECURE_TLS !== '1') return;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn(
    '[MFlixTV] MFL_ALLOW_INSECURE_TLS=1：已关闭上游 TLS 证书校验（自签源可用，公网源请勿开启）'
  );
}
