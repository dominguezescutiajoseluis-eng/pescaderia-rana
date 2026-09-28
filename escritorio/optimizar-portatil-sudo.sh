#!/bin/bash
# Pescadería Rana — optimización del portátil (Linux Mint, 1 núcleo, disco mecánico)
#
# Ejecutar UNA VEZ en el portátil:
#     cd ~ && bash optimizar-portatil-sudo.sh
# Pedirá la contraseña, porque hace cambios del sistema.
set -e
[ "$(id -u)" = 0 ] || { echo "Ejecútalo así:  sudo bash $0"; exit 1; }

echo "== 0) Quitar el paquete VIEJO y roto del facturador (el de la ventana azul) =="
if dpkg -s pescaderia-rana-facturador >/dev/null 2>&1; then
    apt-get remove -y pescaderia-rana-facturador
else
    echo "(ya no está instalado)"
fi

echo "== 1) Menos swap (el disco es mecánico; evita tirones) =="
echo 10 > /proc/sys/vm/swappiness
printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-facturador.conf

echo "== 2) Ajustes del disco: menos escrituras innecesarias =="
echo 20 > /proc/sys/vm/vfs_cache_pressure
echo 15 > /proc/sys/vm/dirty_expire_centisecs
printf 'vm.vfs_cache_pressure=20\nvm.dirty_expire_centisecs=15\n' >> /etc/sysctl.d/90-facturador.conf
# No apagar el disco a los pocos segundos (cada despertar en un HDD es lento)
hdparm -B 254 -S 0 /dev/sda 2>/dev/null || echo "(hdparm no disponible; se omite)"
if ! grep -q "FACTURADOR" /etc/hdparm.conf 2>/dev/null; then
cat >> /etc/hdparm.conf <<EOF

# FACTURADOR: no apagar el disco (cada despertar del HDD va lento)
/dev/sda {
    apm = 254
    spindown_time = 0
}
EOF
fi

echo "== 3) El disco no es SSD: quitar TRIM semanal (no aplica) =="
systemctl disable --now fstrim.timer 2>/dev/null || true

echo "== 4) Buscar actualizaciones solo a las 6:00, nunca en horario de tienda =="
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer man-db.timer 2>/dev/null || true
mkdir -p /etc/systemd/system/apt-daily.timer.d /etc/systemd/system/apt-daily-upgrade.timer.d
printf '[Timer]\nOnCalendar=*-*-* 06:00:00\n' > /etc/systemd/system/apt-daily.timer.d/horario.conf
printf '[Timer]\nOnCalendar=*-*-* 06:15:00\n' > /etc/systemd/system/apt-daily-upgrade.timer.d/horario.conf
systemctl daemon-reload
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer

echo "== 5) Servicios que no usa este portátil =="
systemctl disable --now bluetooth.service 2>/dev/null || true
systemctl disable --now cups.service cups-browsed.service 2>/dev/null || true
systemctl disable --now ModemManager.service 2>/dev/null || true

echo
echo "LISTO. Reinicia el portátil para que todo quede aplicado desde cero:"
echo "    sudo reboot"
