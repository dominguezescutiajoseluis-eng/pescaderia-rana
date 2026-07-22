@echo off
title Pescaderia Rana - Servidor de Trazabilidad y Facturacion
color 0B
cls

cd /d "%~dp0"

echo ======================================================================
echo           PESCADERIA RANA - TRAZABILIDAD Y FACTURACION
echo ======================================================================
echo.
echo  Iniciando servidor local...
echo.

:: Abrir navegador en la PC automaticamente
start http://localhost:8000

:: Lanzar servidor Python dedicado
python server.py

pause
