export function analyzeRun(pages, journeys, network) {
  const findings = []
  const home = pages[0]
  if (!home?.description) findings.push({ level: 'medium', title: '검색 결과 설명이 비어 있습니다', evidence: '첫 화면에 meta description이 없습니다.', action: '페이지의 고객 가치와 주요 검색 의도를 요약하는 설명을 작성하세요.' })
  if (!home?.h1?.length) findings.push({ level: 'high', title: '핵심 제목이 보이지 않습니다', evidence: '첫 화면에 H1 제목이 없습니다.', action: '제품의 대상과 가치를 한 문장으로 표현하는 H1을 추가하세요.' })
  if (home && !home.ctas.some(x => x.aboveFold)) findings.push({ level: 'high', title: '첫 화면에서 행동 경로가 약합니다', evidence: `첫 화면 CTA ${home.ctas.length}개 중 초기 뷰포트에 노출된 CTA가 없습니다.`, action: '방문자가 바로 볼 수 있는 영역에 다음 행동을 안내하는 링크나 버튼을 배치하세요.' })
  for (const page of pages.filter(p => p.error)) findings.push({ level: 'high', title: '페이지 탐색 실패', evidence: `${page.url}: ${page.error}`, action: '링크 대상과 서버 응답을 확인하세요.' })
  for (const page of pages.filter(p => p.status >= 400)) findings.push({ level: 'high', title: '오류 응답 페이지', evidence: `${page.url}에서 HTTP ${page.status} 응답을 받았습니다.`, action: '해당 링크와 서버 응답을 확인하세요.' })
  for (const page of pages.filter(p => p.forms.some(f => f.fields > 5))) findings.push({ level: 'medium', title: '긴 입력 양식', evidence: `${page.url}에 6개 이상의 입력 필드가 있습니다.`, action: '필수 필드 수를 줄이고 나머지는 후속 단계로 옮길 수 있는지 검토하세요.' })
  if (network.failed > 0) findings.push({ level: 'medium', title: '요청 실패가 감지되었습니다', evidence: `캡처 중 ${network.failed}개의 네트워크 요청이 실패했습니다. 차단된 분석 요청은 제외합니다.`, action: '브라우저 콘솔과 네트워크 로그로 실패한 리소스를 확인하세요.' })
  if (!findings.length) findings.push({ level: 'info', title: '기본 탐색에서 큰 장애가 발견되지 않았습니다', evidence: `${pages.length}개 페이지와 ${journeys.length}개 읽기 전용 경로를 확인했습니다.`, action: '실제 사용자 분석 및 접근성 점검으로 다음 개선점을 찾으세요.' })
  return {
    pagesInspected: pages.length,
    journeysCompleted: journeys.filter(j => j.success).length,
    journeysAttempted: journeys.length,
    aboveFoldCtas: home?.ctas.filter(c => c.aboveFold).length || 0,
    requestsBlocked: network.blocked,
    findings
  }
}
