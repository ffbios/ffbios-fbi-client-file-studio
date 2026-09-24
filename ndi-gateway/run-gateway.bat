@echo off
setlocal
python -m pip install -r requirements.txt
set /p FBI_STUDIO_URL=FBI Studio URL: 
set /p FBI_NDI_PAIR_CODE=NDI Pair Code: 
python gateway.py --studio "%FBI_STUDIO_URL%" --pair "%FBI_NDI_PAIR_CODE%"
