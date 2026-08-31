#include "stdafx.h"
#include "permissions.h"

#include <qglobal.h>

#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
#if QT_CONFIG(permissions)
#define RPCS3_QT_PERMISSIONS
#include <QApplication>
#include <QPermissions>
#endif
#endif

LOG_CHANNEL(gui_log, "GUI");
LOG_CHANNEL(camera_log, "Camera");

namespace gui
{
	namespace utils
	{
		void check_microphone_permission()
		{
#ifdef RPCS3_QT_PERMISSIONS
			const QMicrophonePermission permission;
			switch (qApp->checkPermission(permission))
			{
			case Qt::PermissionStatus::Undetermined:
				gui_log.notice("Requesting microphone permission");
				qApp->requestPermission(permission, []()
				{
					check_microphone_permission();
				});
				break;
			case Qt::PermissionStatus::Denied:
				gui_log.error("RPCS3 has no permissions to access microphones on this device.");
				break;
			case Qt::PermissionStatus::Granted:
				gui_log.notice("Microphone permission granted");
				break;
			}
#endif
		}

		bool check_camera_permission(void* obj, std::function<void()> repeat_callback, std::function<void()> denied_callback)
		{
#ifdef RPCS3_QT_PERMISSIONS
			const QCameraPermission permission;
			switch (qApp->checkPermission(permission))
			{
			case Qt::PermissionStatus::Undetermined:
				camera_log.notice("Requesting camera permission");
				qApp->requestPermission(permission, static_cast<QObject*>(obj), [repeat_callback]()
				{
					if (repeat_callback) repeat_callback();
				});
				return false;
			case Qt::PermissionStatus::Denied:
				camera_log.error("RPCS3 has no permissions to access cameras on this device.");
				if (denied_callback) denied_callback();
				return false;
			case Qt::PermissionStatus::Granted:
				camera_log.notice("Camera permission granted");
				break;
			}
#endif
			return true;
		}
	}
}
