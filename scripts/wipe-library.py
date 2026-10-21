# -*- coding: utf-8 -*-
"""一次性清空问题库：全部隐患软删→硬删（不可恢复），并删除磁盘照片文件。"""
import os
import sys
import requests
from concurrent.futures import ThreadPoolExecutor

BASE = 'http://localhost:3100/api'
TOKEN = open(r'C:/Windows/Temp/wsms_admin.jwt', encoding='ascii').read().strip()
HEADERS = {'Authorization': f'Bearer {TOKEN}'}
UPLOADS = r'D:\workshop_programs\wssm\backend\uploads'

def get(path):
    r = requests.get(BASE + path, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()

def delete(path):
    r = requests.delete(BASE + path, headers=HEADERS, timeout=30)
    return r.status_code

def wipe_one(iid):
    s1 = delete(f'/issues/{iid}')          # 先进回收站
    s2 = delete(f'/issues/{iid}/hard')     # 再彻底删除
    return iid, s1, s2

def main():
    normal = get('/issues')
    binned = get('/issues?bin=1')
    print(f'库中 {len(normal)} 条，回收站 {len(binned)} 条')
    all_issues = normal + binned

    photos = set()
    for i in all_issues:
        for p in (i.get('photos') or []):
            name = p.rsplit('/', 1)[-1]
            photos.add(name)
    print(f'关联照片文件 {len(photos)} 个')

    ids = [i['id'] for i in all_issues]
    ok = fail = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        for n, (iid, s1, s2) in enumerate(ex.map(wipe_one, ids), 1):
            if s2 == 200:
                ok += 1
            else:
                fail += 1
                print(f'  删除失败 id={iid} soft={s1} hard={s2}')
            if n % 100 == 0:
                print(f'  进度 {n}/{len(ids)}')
    print(f'条目删除完成：成功 {ok}，失败 {fail}')

    removed = missing = 0
    for name in photos:
        fp = os.path.join(UPLOADS, name)
        if os.path.isfile(fp):
            os.remove(fp)
            removed += 1
        else:
            missing += 1
    print(f'照片文件删除 {removed} 个，磁盘上不存在 {missing} 个')

    left = len(get('/issues')) + len(get('/issues?bin=1'))
    print(f'清空后校验：剩余条目 {left}')

if __name__ == '__main__':
    sys.exit(main())
