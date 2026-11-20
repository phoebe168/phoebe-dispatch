import re, sys
from playwright.sync_api import sync_playwright, expect

pins = {}
for line in open('/home/claude/phoebe-dispatch/test/pins.txt', encoding='utf-8'):
    m = re.search(r'(\S+)（(\d+)）.*?(\d{4})$', line.strip())
    if m: pins[m.group(1)] = (m.group(2), m.group(3))

URL = 'http://localhost:8080/'
OUT = '/home/claude/phoebe-dispatch/test/shots/'
errors = []

def login(page, who):
    phone, pin = pins[who]
    page.fill('#lp', phone); page.fill('#lpin', pin); page.click('button[type=submit]')
    page.wait_for_selector('#logout')

with sync_playwright() as p:
    b = p.chromium.launch()
    # ===== 老師（手機） =====
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(URL); pg.wait_for_selector('#loginForm')
    pg.screenshot(path=OUT + '01_login.png')
    login(pg, '王小美')
    pg.screenshot(path=OUT + '02_teacher_list.png', full_page=True)
    # 第 9 天的案（只能選 9~15 天）
    cards = pg.locator('.card')
    n = cards.count()
    target = None
    for i in range(n):
        if '今天是第 9 天' in cards.nth(i).inner_text(): target = cards.nth(i)
    target.locator('[data-a=reply]').click()
    pg.wait_for_selector('#dates')
    assert pg.locator('.d.normal').count() == 0, '第9天的案不該有正常日期'
    pg.locator('.d.over').first.click()
    assert pg.locator('#send').is_disabled(), '未填原因應不能送出'
    expect(pg.locator('#overBox')).to_be_visible()
    pg.fill('#reason', '家屬要等週末才有空')
    pg.screenshot(path=OUT + '03_teacher_picker_over.png')
    pg.click('#send'); pg.wait_for_selector('.toast:not(.hidden)')
    # 今天派的案：選正常日期
    for i in range(pg.locator('.card').count()):
        if '今天是第 0 天' in pg.locator('.card').nth(i).inner_text(): target = pg.locator('.card').nth(i)
    target.locator('[data-a=reply]').click()
    assert pg.locator('.d').count() == 16
    pg.screenshot(path=OUT + '04_teacher_picker_full.png')
    pg.locator('.d.normal').nth(2).click()
    assert not pg.locator('#send').is_disabled()
    expect(pg.locator('#reasonWrap')).to_be_hidden()
    pg.click('#send'); pg.wait_for_timeout(300)
    pg.click('[data-ttab=待服務]')
    assert pg.locator('.card').count() == 2
    # 申請改時間
    pg.locator('.card').first.locator('[data-a=change]').click()
    pg.locator('.d.over').nth(1).click()
    pg.fill('#reason', '個案回診')
    pg.click('#send'); pg.wait_for_timeout(300)
    pg.screenshot(path=OUT + '05_teacher_waiting.png', full_page=True)
    ctx.close()

    # ===== 管理者（電腦） =====
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    pg = ctx.new_page()
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(URL); login(pg, '美英')
    pg.screenshot(path=OUT + '06_admin_reply.png', full_page=True)
    pg.click('[data-filter=異動待審]')
    assert pg.locator('.card').count() == 1
    pg.screenshot(path=OUT + '07_admin_change.png', full_page=True)
    pg.click('[data-a=approve]'); pg.wait_for_timeout(300)
    pg.click('[data-filter=異動通報]')
    assert pg.locator('.card').count() == 1, pg.locator('.card').count()
    pg.locator('[data-a=notify]').first.click(); pg.wait_for_timeout(300)
    pg.screenshot(path=OUT + '08_admin_report.png', full_page=True)
    # 建立派案
    pg.click('[data-nav=建立派案]')
    pg.fill('#fName', '測試新案'); pg.select_option('#fSvc', index=1); pg.select_option('#fT', index=1)
    pg.screenshot(path=OUT + '09_admin_create.png', full_page=True)
    pg.click('#fSave'); pg.wait_for_timeout(300)
    assert '測試新案' in pg.inner_text('#app')
    # 帳號
    pg.click('[data-nav=帳號]')
    pg.fill('#uName', '新老師'); pg.fill('#uPhone', '0933111222')
    pg.click('[data-a=addUser]'); pg.wait_for_selector('.bigpin')
    pg.screenshot(path=OUT + '10_admin_pin.png')
    pg.click('[data-close]')
    pg.screenshot(path=OUT + '11_admin_users.png', full_page=True)
    # 管理者重新開瀏覽器要再輸 PIN（sessionStorage）
    pg2 = ctx.new_page(); pg2.goto(URL); pg2.wait_for_selector('#loginForm')
    assert pg2.input_value('#lp') == pins['美英'][0], '應記住管理者手機'
    ctx.close()

    # 手機看管理者畫面
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    pg = ctx.new_page(); pg.goto(URL); login(pg, '美英')
    pg.screenshot(path=OUT + '12_admin_mobile.png', full_page=True)
    ctx.close()

    # 老師重新開頁面直接進入
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    pg = ctx.new_page(); pg.goto(URL); login(pg, '李大華')
    pg.goto(URL); pg.wait_for_selector('#logout')
    ctx.close()
    b.close()

print('UI 測試通過')
if errors:
    print('console 錯誤：', errors); sys.exit(1)
