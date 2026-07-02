import { HttpException } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { PrismaService } from '../prisma/prisma.service';

describe('EntitlementsService production task recipe access', () => {
    const productCount = jest.fn();
    const service = new EntitlementsService({ product: { count: productCount } } as unknown as PrismaService);

    beforeEach(() => {
        productCount.mockReset();
    });

    it('allows trial and paid tenants to use recipes that retain a free-tier restriction marker', async () => {
        jest.spyOn(service, 'getSummary').mockResolvedValueOnce({
            fullAccess: true,
            limits: { productionTasksPerMonth: null },
            usage: { productionTasksThisMonth: 0 },
        } as never);

        await expect(service.assertCanCreateProductionTask('tenant-id', ['product-id'])).resolves.toBeUndefined();
        expect(productCount).not.toHaveBeenCalled();
    });

    it('continues checking restricted recipes for free tenants', async () => {
        jest.spyOn(service, 'getSummary').mockResolvedValueOnce({
            fullAccess: false,
            limits: { productionTasksPerMonth: 10 },
            usage: { productionTasksThisMonth: 0 },
        } as never);
        productCount.mockResolvedValueOnce(1);

        await expect(service.assertCanCreateProductionTask('tenant-id', ['product-id'])).rejects.toBeInstanceOf(
            HttpException,
        );
        expect(productCount).toHaveBeenCalledTimes(1);
    });
});
