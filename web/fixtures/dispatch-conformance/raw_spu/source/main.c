#include <stdint.h>
#include <spu_intrinsics.h>

int main(void)
{
	spu_writech(SPU_WrOutMbox, 0x1337baad);
	return 0;
}
