// 텍스트와 선택적 로컬 이미지로 토스트 XML을 구성한다.
using System.Security;

/** 토스트의 활성화 payload·텍스트·이미지 경로를 XML로 이스케이프한다. */
internal static class ToastContent
{
    internal static string Build(string title, string message, string launch, string? imagePath)
    {
        var image = "";
        if (!string.IsNullOrWhiteSpace(imagePath) && Path.IsPathFullyQualified(imagePath) && File.Exists(imagePath))
        {
            var source = SecurityElement.Escape(new Uri(Path.GetFullPath(imagePath)).AbsoluteUri);
            image = $"<image placement=\"appLogoOverride\" hint-crop=\"none\" src=\"{source}\" alt=\"Notification icon\"/>";
        }
        return $"<toast activationType=\"foreground\" launch=\"{SecurityElement.Escape(launch)}\"><visual><binding template=\"ToastGeneric\"><text>{SecurityElement.Escape(title)}</text><text>{SecurityElement.Escape(message)}</text>{image}</binding></visual><audio silent=\"true\"/></toast>";
    }
}
